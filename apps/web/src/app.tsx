import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  isRuntimeSettingsResponse, isSystemHealth, runtimeSettingLimits,
  type RuntimeSettings, type RuntimeSettingsResponse, type SystemHealth,
} from '@vibe-invest/contracts'

type Page = 'overview' | 'analysis' | 'research' | 'portfolio' | 'settings'
type Position = { symbol: string; quantity: number; averageCost: number }
type PortfolioPosition = Position & {
  costAmount: number; marketPrice: number | null; marketValue: number | null
  unrealizedProfitLoss: number | null; unrealizedReturn: number | null; portfolioWeight: number | null
}
type PortfolioOverview = {
  cash: number; totalCost: number; totalMarketValue: number | null; totalEquity: number | null
  totalUnrealizedProfitLoss: number | null; totalUnrealizedReturn: number | null
  pricedPositionCount: number; unpricedPositionCount: number; positions: PortfolioPosition[]
}
type PortfolioEquitySnapshot = {
  marketDay: string; totalEquity: number; totalMarketValue: number; cash: number
  holdingsCount: number; pricedCount: number; observedAt: string; afterClose: boolean
  dailyChange: number | null; dailyReturn: number | null
}
type ResearchSummary = { id: string; symbol: string; status: string; createdAt?: string; reportCreatedAt?: string | null; error?: string | null; starred?: boolean; note?: string; report?: { title?: string; trend?: string } }
type Fact = { id: string; type: string; value: unknown; observedAt: string; source: string; sourceReference: string }
type Report = {
  title?: string; marketState?: string; trend?: string; drivers?: string[]
  supportingEvidence?: string[]; contraryEvidence?: string[]
  keyJudgments?: Array<{ judgment: string; evidence: string[] }>
  scenarios?: Array<{ name: string; condition: string; outcome: string }>
  invalidationConditions?: string[]; valuation?: string | null
  personalImpact?: string | null; conditionalSuggestion?: string | null
  limitations?: string[]
}
type ResearchRecord = ResearchSummary & {
  report?: Report
  facts: Fact[]
  trace: Array<Record<string, unknown>>
  snapshot?: { gaps?: Array<{ capability?: string; reason?: string }> }
  mainAgent?: {
    id: string; status: string
    waitReason: { kind: string; target: string; startedAt: string } | null
    execution: { id: string; generation: number; status: string }
    segments: Array<{ id: string; ordinal: number; createdAt: string }>
    events: Array<{
      sequence: number; type?: string; status?: string; createdAt: string
      waitReason?: { kind: string; target: string; startedAt: string } | null
    }>
  }
}

const pages: Array<{ id: Page; label: string }> = [
  { id: 'overview', label: '总览' },
  { id: 'analysis', label: '新建分析' },
  { id: 'research', label: '研究记录' },
  { id: 'portfolio', label: '我的持仓' },
  { id: 'settings', label: '系统设置' },
]

export function App() {
  const [page, setPage] = useState<Page>('overview')
  const [health, setHealth] = useState<SystemHealth | null>(null)
  const [modelConfigured, setModelConfigured] = useState(false)
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettingsResponse | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [portfolio, setPortfolio] = useState<PortfolioOverview>(emptyPortfolio())
  const [portfolioHistory, setPortfolioHistory] = useState<PortfolioEquitySnapshot[]>([])
  const [records, setRecords] = useState<ResearchSummary[]>([])
  const [selectedResearch, setSelectedResearch] = useState<ResearchRecord | null>(null)
  const [analysisSymbol, setAnalysisSymbol] = useState('NVDA')
  const [analysisStatus, setAnalysisStatus] = useState('')
  const [analysisStages, setAnalysisStages] = useState<string[]>([])
  const [activeAnalysisId, setActiveAnalysisId] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function loadPortfolio() {
    const response = await fetch('/api/portfolio')
    const next = await response.json() as PortfolioOverview
    const historyResponse = await fetch('/api/portfolio/history?limit=30')
    setPortfolio(next)
    setPortfolioHistory((await historyResponse.json() as { snapshots: PortfolioEquitySnapshot[] }).snapshots)
    setPositions(next.positions.map(({ symbol, quantity, averageCost }) => ({ symbol, quantity, averageCost })))
  }
  async function loadResearch() {
    const response = await fetch('/api/research')
    const next = (await response.json()).records as ResearchSummary[]
    setRecords(next)
    if (!selectedResearch && next[0]) void openResearch(next[0].id)
  }
  async function loadSettings() {
    const value: unknown = await fetch('/api/settings').then((response) => response.json())
    if (!isRuntimeSettingsResponse(value)) throw new Error('settings_contract_invalid')
    setModelConfigured(value.model.configured)
    setRuntimeSettings(value)
  }
  useEffect(() => {
    void Promise.all([
      fetch('/api/health').then((response) => response.json()).then((value: unknown) => {
        if (!isSystemHealth(value)) throw new Error('health_contract_invalid')
        setHealth(value)
      }),
      loadSettings(),
      loadPortfolio(), loadResearch(),
    ]).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [])
  useEffect(() => {
    const agent = selectedResearch?.mainAgent
    if (page !== 'research' || !agent || !('EventSource' in globalThis)
      || ['completed', 'partial', 'failed', 'stopped', 'interrupted', 'budget_exhausted'].includes(agent.status)) return
    const source = new EventSource(`/api/agent-sessions/${agent.id}/events`, {
      withCredentials: false,
    })
    const refresh = () => { void openResearch(selectedResearch.id) }
    for (const name of ['runtime_context', 'planning', 'running_model', 'running_tools',
      'waiting_for_specialists', 'finalizing', 'completed', 'partial', 'failed',
      'stopping', 'stopped', 'interrupted', 'budget_exhausted']) {
      source.addEventListener(name, refresh)
    }
    return () => source.close()
  }, [page, selectedResearch?.id, selectedResearch?.mainAgent?.status])

  async function savePosition(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const symbol = String(data.get('symbol')).trim().toUpperCase()
    const response = await fetch(`/api/positions/${symbol}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: Number(data.get('quantity')), averageCost: Number(data.get('averageCost')) }),
    })
    if (!response.ok) throw new Error('持仓保存失败')
    form.reset()
    await loadPortfolio()
  }
  async function removePosition(symbol: string) {
    await fetch(`/api/positions/${symbol}`, { method: 'DELETE' })
    await loadPortfolio()
  }
  async function saveCash(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cash = Number(new FormData(event.currentTarget).get('cash'))
    const response = await fetch('/api/portfolio/cash', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cash }),
    })
    if (!response.ok) { setError('现金保存失败'); return }
    await loadPortfolio()
  }
  async function reducePosition(symbol: string, quantity: number, price: number) {
    const response = await fetch(`/api/positions/${symbol}/reduce`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quantity, price }),
    })
    if (!response.ok) { setError('减仓失败：请检查卖出数量和成交价。'); return false }
    await loadPortfolio()
    return true
  }
  async function startAnalysis(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    const response = await fetch('/api/analyses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: analysisSymbol.trim().toUpperCase() }),
    })
    const { analysisId, sessionId } = await response.json()
    if (!response.ok || !analysisId) { setError('分析任务创建失败'); return }
    setAnalysisStatus('queued')
    setAnalysisStages(['queued'])
    setActiveAnalysisId(analysisId)
    if (!modelConfigured) {
      await openResearch(analysisId)
      setPage('research')
      await loadResearch()
      return
    }
    if ('EventSource' in globalThis && sessionId) streamAnalysis(sessionId, analysisId)
    else await pollAnalysis(analysisId)
  }
  function addStage(stage: string) {
    setAnalysisStages((current) => current.includes(stage) ? current : [...current, stage])
  }
  function streamAnalysis(sessionId: string, analysisId: string) {
    const source = new EventSource(`/api/agent-sessions/${sessionId}/events`)
    const eventNames = ['runtime_context', 'planning', 'running_model', 'running_tools', 'waiting_for_specialists', 'finalizing', 'financial_context', 'model_event', 'text_delta', 'model_completed', 'completed', 'partial', 'failed', 'stopping', 'stopped', 'interrupted', 'budget_exhausted']
    for (const name of eventNames) source.addEventListener(name, (event) => {
      const entry = JSON.parse((event as MessageEvent).data) as Record<string, unknown>
      if (name !== 'text_delta') addStage(name)
      if (['planning', 'running_model', 'running_tools', 'waiting_for_specialists', 'finalizing', 'completed', 'partial', 'failed', 'stopping', 'stopped', 'interrupted', 'budget_exhausted'].includes(name)) setAnalysisStatus(name)
      if (['completed', 'partial', 'failed', 'stopped', 'interrupted', 'budget_exhausted'].includes(name)) {
        if (name === 'failed' && typeof entry.error === 'string') setError(friendlyError(entry.error))
        source.close()
        setActiveAnalysisId(null)
        void openResearch(analysisId).then(() => { setPage('research'); return loadResearch() })
      }
    })
    source.onerror = () => { source.close(); void pollAnalysis(analysisId) }
  }
  async function pollAnalysis(id: string) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const status = await fetch(`/api/analyses/${id}`).then((response) => response.json())
      setAnalysisStatus(status.status)
      addStage(status.status)
      if (['completed', 'partial', 'failed', 'stopped', 'interrupted', 'budget_exhausted'].includes(status.status)) {
        if (status.status === 'failed' && typeof status.error === 'string') setError(friendlyError(status.error))
        const researchResponse = await fetch(`/api/research/${id}`)
        if (researchResponse.ok) setSelectedResearch(await researchResponse.json())
        await loadResearch()
        setActiveAnalysisId(null)
        setPage('research')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    setError('分析等待超时')
  }
  async function openResearch(id: string) {
    const response = await fetch(`/api/research/${id}`)
    if (response.ok) setSelectedResearch(await response.json())
  }
  async function cancelAnalysis() {
    if (activeAnalysisId) await fetch(`/api/analyses/${activeAnalysisId}/cancel`, { method: 'POST' })
  }
  async function updateResearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedResearch) return
    const data = new FormData(event.currentTarget)
    const response = await fetch(`/api/research/${selectedResearch.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ starred: data.get('starred') === 'on', note: String(data.get('note') ?? '') }),
    })
    setSelectedResearch({ ...selectedResearch, ...await response.json() })
    await loadResearch()
  }
  async function removeResearch() {
    if (!selectedResearch) return
    await fetch(`/api/research/${selectedResearch.id}`, { method: 'DELETE' })
    setSelectedResearch(null)
    await loadResearch()
  }
  function navigate(next: Page) { setPage(next); window.scrollTo({ top: 0, behavior: 'smooth' }) }

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => navigate('overview')}><strong>vibe<i>.</i>invest</strong><span>SELF-HOSTED</span></button>
      <nav aria-label="主导航">{pages.map((item) => <button className={page === item.id ? 'active' : ''} key={item.id} onClick={() => navigate(item.id)}>{item.label}</button>)}</nav>
      <SystemBadge health={health} modelConfigured={modelConfigured} />
    </header>
    <main className="page-main">
      {error && <p role="alert" className="error-banner">{error}</p>}
      {page === 'overview' && <Overview records={records} selected={selectedResearch} positions={positions} health={health} modelConfigured={modelConfigured} onNavigate={navigate} onOpen={async (id) => { await openResearch(id); navigate('research') }} />}
      {page === 'analysis' && <AnalysisPage symbol={analysisSymbol} setSymbol={setAnalysisSymbol} status={analysisStatus} stages={analysisStages} active={Boolean(activeAnalysisId)} onStart={startAnalysis} onCancel={cancelAnalysis} health={health} modelConfigured={modelConfigured} records={records} onOpen={async (id) => { await openResearch(id); navigate('research') }} />}
      {page === 'research' && <ResearchPage records={records} record={selectedResearch} onOpen={openResearch} onUpdate={updateResearch} onDelete={removeResearch} freshnessDays={runtimeSettings?.current.values.reportFreshnessDays ?? null} />}
      {page === 'portfolio' && <PortfolioPage portfolio={portfolio} history={portfolioHistory} onSave={savePosition} onSaveCash={saveCash} onReduce={reducePosition} onDelete={removePosition} />}
      {page === 'settings' && <SettingsPage health={health} modelConfigured={modelConfigured} settings={runtimeSettings} onReload={loadSettings} />}
    </main>
  </div>
}

function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="page-header"><p className="micro">{eyebrow}</p><h1>{title}</h1><p>{description}</p></header>
}

function Overview({ records, selected, positions, health, modelConfigured, onNavigate, onOpen }: {
  records: ResearchSummary[]; selected: ResearchRecord | null; positions: Position[]; health: SystemHealth | null; modelConfigured: boolean
  onNavigate: (page: Page) => void; onOpen: (id: string) => Promise<void>
}) {
  const quote = selected?.facts.find((fact) => fact.type === 'quote')
  const indicators = selected?.facts.find((fact) => fact.type === 'indicators')
  const indicator = asRecord(indicators?.value)
  return <>
    <PageHeader eyebrow="PERSONAL RESEARCH DESK" title="你的研究，从今天最重要的判断开始。" description="行情、新闻、估值和个人持仓汇入同一份可追溯的研究简报。" />
    <div className="overview-grid">
      <section className="lead-story"><p className="micro">最近研究</p><h2>{selected?.report?.title ?? '还没有研究记录'}</h2><p>{selected?.report?.trend ?? '选择一只美股，生成第一份一至四周研究简报。'}</p><button onClick={() => onNavigate(selected ? 'research' : 'analysis')}>{selected ? '阅读完整简报' : '开始第一次分析'}</button></section>
      <section className="market-snapshot"><p className="micro">市场快照</p><div className="quote-row"><strong>{selected?.symbol ?? '—'}</strong><span>{quote ? formatMoney(Number(quote.value)) : '暂无价格'}</span></div><PriceChart facts={selected?.facts ?? []} compact /><div className="metric-row"><Metric label="MA 5" value={formatMaybeMoney(indicator.ma_5)} /><Metric label="MA 20" value={formatMaybeMoney(indicator.ma_20)} /><Metric label="RSI 14" value={formatMaybeNumber(indicator.rsi_14)} /></div></section>
      <section className="portfolio-summary"><p className="micro">个人相关性</p><strong>{positions.length}</strong><span>项手工持仓</span><p>{positions.length ? '分析时将自动加入当前标的成本与组合语境。' : '尚未录入持仓，当前报告属于公共市场分析。'}</p><button className="quiet" onClick={() => onNavigate('portfolio')}>管理持仓</button></section>
      <section className="system-summary"><p className="micro">实例能力</p><StatusRow label="Analysis API" ready={health?.status === 'ok'} /><StatusRow label="金融数据" ready={health?.dependencies.financialData.status === 'ok'} /><StatusRow label="AI 模型" ready={modelConfigured} /></section>
      <section className="recent-list"><p className="micro">研究档案 · {records.length}</p>{records.slice(0, 4).map((record) => <button key={record.id} onClick={() => void onOpen(record.id)}><strong>{record.symbol}</strong><span>{record.report?.title ?? statusLabel(record.status)}</span><small>{statusLabel(record.status)}</small></button>)}</section>
    </div>
  </>
}

function AnalysisPage({ symbol, setSymbol, status, stages, active, onStart, onCancel, health, modelConfigured, records, onOpen }: {
  symbol: string; setSymbol: (value: string) => void; status: string; stages: string[]; active: boolean
  onStart: (event: React.FormEvent) => Promise<void>; onCancel: () => Promise<void>; health: SystemHealth | null; modelConfigured: boolean
  records: ResearchSummary[]; onOpen: (id: string) => Promise<void>
}) {
  const pipeline = ['queued', 'running', 'financial_context', 'model_event', 'model_completed', 'completed']
  const current = pipelineIndex(status, stages)
  return <>
    <PageHeader eyebrow="NEW ANALYSIS" title="发起一份新的研究简报" description="输入标的后，系统会冻结本次使用的行情、新闻、财报、估值和持仓语境。" />
    <div className="analysis-grid">
      <section className="analysis-start"><p className="micro">01 / 选择研究对象</p><form onSubmit={(event) => void onStart(event)}><label>美股代码<div className="symbol-field"><input aria-label="分析标的" value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} required /><button type="submit" disabled={active}>{active ? '分析进行中' : '开始分析'}</button></div></label></form><p className="hint">默认周期：未来 1—4 周 · 自动匹配当前持仓</p>{active && <button className="quiet danger" onClick={() => void onCancel()}>取消本次分析</button>}</section>
      <section className="pipeline"><p className="micro">02 / 分析进度</p>{pipeline.map((stage, index) => <div className={index < current ? 'done' : index === current ? 'active' : ''} key={stage}><i>{index + 1}</i><span>{pipelineLabel(stage)}</span><small>{index < current ? '完成' : index === current ? statusLabel(status) : '等待'}</small></div>)}</section>
      <section className="capabilities"><p className="micro">本次所需能力</p><StatusRow label="行情与历史数据" ready={health?.dependencies.financialData.status === 'ok'} /><StatusRow label="新闻与财报材料" ready={health?.dependencies.financialData.status === 'ok'} /><StatusRow label="确定性指标与估值" ready={health?.dependencies.financialData.status === 'ok'} /><StatusRow label="AI 综合分析" ready={modelConfigured} /><p className="callout">数据缺失时，依赖该数据的结论会关闭，并在报告中明确说明。</p></section>
      <section className="analysis-history" aria-label="分析历史"><header><div><p className="micro">分析历史</p><h2>继续之前的研究</h2></div><span>{records.length} 份记录</span></header>{records.length ? <div className="analysis-history-list">{records.map((record) => { const title = record.report?.title ?? `${record.symbol} · ${statusLabel(record.status)}`; return <button key={record.id} aria-label={`打开 ${title}`} onClick={() => void onOpen(record.id)}><strong>{record.symbol}</strong><span>{title}</span><small>{formatAnalysisDate(record.createdAt)} · {statusLabel(record.status)}</small><i aria-hidden="true">→</i></button> })}</div> : <p className="analysis-history-empty">还没有分析记录。完成第一份分析后，可从这里重新打开。</p>}</section>
    </div>
  </>
}

function ResearchPage({ records, record, onOpen, onUpdate, onDelete, freshnessDays }: {
  records: ResearchSummary[]; record: ResearchRecord | null; onOpen: (id: string) => Promise<void>
  onUpdate: (event: React.FormEvent<HTMLFormElement>) => Promise<void>; onDelete: () => Promise<void>
  freshnessDays: number | null
}) {
  return <>
    <PageHeader eyebrow="RESEARCH ARCHIVE" title="研究记录" description="每份报告都绑定当时的数据快照、来源和分析轨迹，结论变化也有迹可循。" />
    <div className="research-layout">
      <aside className="research-index"><p className="micro">全部记录 · {records.length}</p>{records.map((item) => <button className={record?.id === item.id ? 'active' : ''} key={item.id} onClick={() => void onOpen(item.id)}><strong>{item.symbol}</strong><span>{item.report?.title ?? statusLabel(item.status)}</span><small>{item.starred ? `已标记 · ${statusLabel(item.status)}` : statusLabel(item.status)}</small></button>)}</aside>
      <ResearchReport record={record} onUpdate={onUpdate} onDelete={onDelete} freshnessDays={freshnessDays} />
      <div><AgentRuntime agent={record?.mainAgent} /><TraceSummary trace={record?.trace ?? []} /></div>
    </div>
  </>
}

function AgentRuntime({ agent }: { agent?: ResearchRecord['mainAgent'] }) {
  if (!agent) return null
  return <section className="agent-runtime" role="region" aria-label="主 Agent Runtime">
    <p className="micro">主 Agent</p>
    <h2>{statusLabel(agent.status)}</h2>
    <p>Session {agent.id}</p>
    <p>Execution {agent.execution.id} · Generation {agent.execution.generation}</p>
    {agent.waitReason && <p>等待：{agent.waitReason.target} · {formatTime(agent.waitReason.startedAt)}</p>}
    <div>{agent.segments.map((segment) => <span key={segment.id}>Segment {segment.ordinal}</span>)}</div>
    <ol>{agent.events.map((event) => <li key={event.sequence}>
      #{event.sequence} {event.type === 'runtime_context' ? 'Runtime Context' : statusLabel(event.status ?? event.type ?? '')}
      {' · '}{formatTime(event.createdAt)}
      {event.waitReason && <> · 等待 {event.waitReason.target}（始于 {formatTime(event.waitReason.startedAt)}）</>}
    </li>)}</ol>
  </section>
}

function ResearchReport({ record, onUpdate, onDelete, freshnessDays }: {
  record: ResearchRecord | null; onUpdate: (event: React.FormEvent<HTMLFormElement>) => Promise<void>; onDelete: () => Promise<void>
  freshnessDays: number | null
}) {
  if (!record) return <article className="research-report empty">选择一条研究记录开始阅读。</article>
  const facts = new Map(record.facts.map((fact) => [fact.id, fact]))
  const report = record.report
  const indicatorFact = record.facts.find((fact) => fact.type === 'indicators')
  const indicator = asRecord(indicatorFact?.value)
  const valuationFact = record.facts.find((fact) => fact.type === 'valuation')
  const stale = freshnessDays !== null && isReportOlderThan(record.reportCreatedAt, freshnessDays)
  return <article className="research-report">
    <header className="report-title"><div><p className="micro">{record.symbol} · {statusLabel(record.status)}</p><h2>{report?.title ?? '受限分析'}</h2>{stale && <p role="status" className="data-warning">此报告已超过当前 {freshnessDays} 天有效期，请重新生成后再据此判断。</p>}</div><span className={`verdict ${record.status}`}>{trendVerdict(report?.trend)}<small>未来 1—4 周</small></span></header>
    {record.error && <p role="alert" className="error-banner">{friendlyError(record.error)}</p>}
    <section className="report-hero"><div><p className="micro">当前市场状态</p><p>{report?.marketState ?? '没有足够数据形成市场状态判断。'}</p><strong>{report?.trend}</strong></div><PriceChart facts={record.facts} /></section>
    <section className="indicator-strip"><Metric label="MA 5" value={formatMaybeMoney(indicator.ma_5)} /><Metric label="MA 20" value={formatMaybeMoney(indicator.ma_20)} /><Metric label="RSI 14" value={formatMaybeNumber(indicator.rsi_14)} /><Metric label="年化波动" value={formatPercent(indicator.annualized_volatility)} /><Metric label="最大回撤" value={formatPercent(indicator.max_drawdown)} /></section>
    {!!report?.drivers?.length && <ReportBlock number="01" title="主要驱动"><BulletList values={report.drivers} /></ReportBlock>}
    {!!report?.keyJudgments?.length && <ReportBlock number="02" title="关键判断与依据"><div className="judgments">{report.keyJudgments.map((item, index) => <section key={index}><strong>{item.judgment}</strong><Evidence facts={facts} ids={item.evidence} /></section>)}</div></ReportBlock>}
    {valuationFact && <ReportBlock number="03" title="估值温度"><ValuationView fact={valuationFact} explanation={report?.valuation} /></ReportBlock>}
    {!!report?.scenarios?.length && <ReportBlock number="04" title="未来情景"><div className="scenarios">{report.scenarios.map((scenario) => <section key={scenario.name}><strong>{scenario.name}</strong><p><b>条件</b>{scenario.condition}</p><p><b>可能结果</b>{scenario.outcome}</p></section>)}</div></ReportBlock>}
    {!!report?.invalidationConditions?.length && <ReportBlock number="05" title="判断失效条件"><BulletList values={report.invalidationConditions} /></ReportBlock>}
    {(report?.personalImpact || report?.conditionalSuggestion) && <ReportBlock number="06" title="与你的持仓"><p>{report.personalImpact}</p>{report.conditionalSuggestion && <p className="suggestion">条件式方向：{report.conditionalSuggestion}</p>}</ReportBlock>}
    <details className="evidence-drawer"><summary>查看全部支持与相反证据</summary><div className="evidence-columns"><section><h3>支持证据</h3><Evidence facts={facts} ids={report?.supportingEvidence ?? []} /></section><section><h3>相反证据</h3><Evidence facts={facts} ids={report?.contraryEvidence ?? []} /></section></div></details>
    {!!report?.limitations?.length && <section className="limitations"><p className="micro">数据与分析限制</p><BulletList values={report.limitations} /></section>}
    <form className="research-meta" onSubmit={(event) => void onUpdate(event)}><label><input type="checkbox" name="starred" defaultChecked={record.starred} /> 标记这份研究</label><label>个人备注<textarea name="note" defaultValue={record.note ?? ''} /></label><div><button type="submit">保存备注</button><button type="button" className="quiet danger" onClick={() => void onDelete()}>删除记录</button></div></form>
  </article>
}

function PortfolioPage({ portfolio, history, onSave, onSaveCash, onReduce, onDelete }: {
  portfolio: PortfolioOverview
  history: PortfolioEquitySnapshot[]
  onSave: (event: React.FormEvent<HTMLFormElement>) => Promise<void>
  onSaveCash: (event: React.FormEvent<HTMLFormElement>) => Promise<void>
  onReduce: (symbol: string, quantity: number, price: number) => Promise<boolean>
  onDelete: (symbol: string) => Promise<void>
}) {
  const [reducing, setReducing] = useState<PortfolioPosition | null>(null)
  return <><PageHeader eyebrow="PRIVATE PORTFOLIO" title="我的持仓" description="现金、持仓市值和盈亏共同构成你的组合语境；行情缺失时不猜测组合总值。" />
    <div className="portfolio-kpis">
      <PortfolioKpi label="组合总值" value={formatNullableMoney(portfolio.totalEquity)} note="持仓市值 + USD 现金" />
      <PortfolioKpi label="持仓市值" value={formatNullableMoney(portfolio.totalMarketValue)} note={`${portfolio.pricedPositionCount}/${portfolio.positions.length} 项有行情`} />
      <PortfolioKpi label="USD 现金" value={formatMoney(portfolio.cash)} note={portfolio.totalEquity ? `占组合 ${formatPercent(portfolio.cash / portfolio.totalEquity)}` : '独立手工维护'} />
      <PortfolioKpi label="未实现盈亏" value={formatSignedMoney(portfolio.totalUnrealizedProfitLoss)} note={portfolio.totalUnrealizedReturn === null ? '行情不可用' : formatSignedPercent(portfolio.totalUnrealizedReturn)} tone={portfolio.totalUnrealizedProfitLoss} />
    </div>
    <div className="portfolio-visuals">
      <PortfolioDonut portfolio={portfolio} />
      <PositionBars positions={portfolio.positions} mode="weight" />
      <PositionBars positions={portfolio.positions} mode="profit" />
    </div>
    <EquityHistory history={history} />
    <section className="portfolio-holdings">
      <header><div><p className="micro">当前持仓 · {portfolio.positions.length}</p><h2>组合明细</h2></div>{portfolio.unpricedPositionCount > 0 && <p className="data-warning">{portfolio.unpricedPositionCount} 项行情缺失，组合汇总已关闭。</p>}</header>
      <div className="portfolio-table-scroll"><div className="portfolio-table-row head"><span>标的</span><span>数量</span><span>平均成本</span><span>当前价</span><span>市值</span><span>仓位</span><span>未实现盈亏</span><span /></div>
        {portfolio.positions.map((item) => <div className="portfolio-table-row" key={item.symbol}><strong>{item.symbol}</strong><span>{formatNumber(item.quantity)}</span><span>{formatMoney(item.averageCost)}</span><span>{formatNullableMoney(item.marketPrice)}</span><span>{formatNullableMoney(item.marketValue)}</span><span>{item.portfolioWeight === null ? '—' : formatPercent(item.portfolioWeight)}</span><span className={valueTone(item.unrealizedProfitLoss)}>{formatSignedMoney(item.unrealizedProfitLoss)}<small>{item.unrealizedReturn === null ? '' : formatSignedPercent(item.unrealizedReturn)}</small></span><span className="position-actions"><button className="quiet" onClick={() => setReducing(item)}>减仓</button><button className="text-button" onClick={() => void onDelete(item.symbol)}>删除</button></span></div>)}
        {!portfolio.positions.length && <p className="empty-row">尚未录入持仓。</p>}
      </div>
    </section>
    <div className="portfolio-editors"><section className="cash-form"><p className="micro">现金余额</p><h2>维护 USD 现金</h2><form onSubmit={(event) => void onSaveCash(event)}><label>当前现金<input key={portfolio.cash} name="cash" aria-label="当前现金" type="number" min="0" step="any" defaultValue={portfolio.cash} required /></label><button type="submit">保存现金</button></form><p>现金不会因手工录入已有持仓自动变化；只有明确减仓时，卖出所得会计入现金。</p></section><section className="position-form"><p className="micro">新增或更新持仓</p><form onSubmit={(event) => void onSave(event)}><label>股票代码<input name="symbol" aria-label="股票代码" required /></label><label>数量<input name="quantity" aria-label="数量" type="number" min="0.000001" step="any" required /></label><label>平均成本<input name="averageCost" aria-label="平均成本" type="number" min="0" step="any" required /></label><button type="submit">保存持仓</button></form><p>这是手工快照录入，不代表系统执行了一笔买入交易。</p></section></div>
    {reducing && <ReduceDialog position={reducing} cash={portfolio.cash} onCancel={() => setReducing(null)} onSubmit={async (quantity, price) => { if (await onReduce(reducing.symbol, quantity, price)) setReducing(null) }} />}
  </>
}

function EquityHistory({ history }: { history: PortfolioEquitySnapshot[] }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const chronological = [...history].reverse()
  useEffect(() => { if (canvas.current) drawEquityHistory(canvas.current, chronological) }, [history.map((item) => `${item.marketDay}:${item.totalEquity}`).join('|')])
  return <section className="equity-history"><header><div><p className="micro">组合权益历史 · 最近 {history.length} 个估值日</p><h2>组合总值怎样变化</h2></div><p>总权益 = 持仓市值 + USD 现金</p></header>
    {history.length > 1 ? <figure><canvas ref={canvas} role="img" aria-label={`组合权益历史，共 ${history.length} 个观测点`} /><figcaption><span>{chronological[0].marketDay}</span><span>USD</span><span>{chronological.at(-1)?.marketDay}</span></figcaption></figure> : <p className="chart-empty">产生至少两个完整估值日后显示权益曲线</p>}
    {!!history.length && <div className="equity-table-scroll"><table aria-label="组合权益历史明细"><thead><tr><th>日期</th><th>总权益</th><th>持仓市值</th><th>现金</th><th>单日变动</th><th>涨跌幅</th><th>行情覆盖</th><th>状态</th></tr></thead><tbody>{history.map((item) => <tr key={item.marketDay}><td>{item.marketDay}</td><td><strong>{formatMoney(item.totalEquity)}</strong></td><td>{formatMoney(item.totalMarketValue)}</td><td>{formatMoney(item.cash)}</td><td className={valueTone(item.dailyChange)}>{formatSignedMoneyOrDash(item.dailyChange)}</td><td className={valueTone(item.dailyReturn)}>{formatSignedPercentOrDash(item.dailyReturn)}</td><td>{item.pricedCount}/{item.holdingsCount}</td><td><b className={item.afterClose ? 'history-status close' : 'history-status'}>{item.afterClose ? '收盘' : '盘中'}</b></td></tr>)}</tbody></table></div>}
  </section>
}

function PortfolioKpi({ label, value, note, tone }: { label: string; value: string; note: string; tone?: number | null }) { return <section><p className="micro">{label}</p><strong className={valueTone(tone)}>{value}</strong><span>{note}</span></section> }

function PortfolioDonut({ portfolio }: { portfolio: PortfolioOverview }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const segments = portfolio.positions.flatMap((item) => item.marketValue === null || item.marketValue <= 0 ? [] : [{ label: item.symbol, value: item.marketValue }])
  if (portfolio.cash > 0) segments.push({ label: '现金', value: portfolio.cash })
  useEffect(() => { if (canvas.current) drawAllocationDonut(canvas.current, segments) }, [segments.map((item) => `${item.label}:${item.value}`).join('|')])
  return <section className="portfolio-donut"><p className="micro">资产构成</p><h2>持仓与现金</h2>{segments.length ? <><canvas ref={canvas} role="img" aria-label={segments.map((item) => `${item.label} ${formatMoney(item.value)}`).join('，')} /><div className="donut-legend">{segments.map((item, index) => <span key={item.label}><i style={{ background: chartColors[index % chartColors.length] }} />{item.label}<strong>{formatPercent(item.value / segments.reduce((sum, entry) => sum + entry.value, 0))}</strong></span>)}</div></> : <p className="chart-empty">录入现金或持仓后显示资产构成</p>}</section>
}

function PositionBars({ positions, mode }: { positions: PortfolioPosition[]; mode: 'weight' | 'profit' }) {
  const values = positions.flatMap((item) => { const value = mode === 'weight' ? item.portfolioWeight : item.unrealizedProfitLoss; return value === null ? [] : [{ symbol: item.symbol, value }] })
  const max = Math.max(...values.map((item) => Math.abs(item.value)), 0)
  return <section className="portfolio-bars"><p className="micro">{mode === 'weight' ? '仓位分布' : '盈亏分解'}</p><h2>{mode === 'weight' ? '谁占用了组合' : '谁在贡献盈亏'}</h2>{values.length ? values.map((item) => <div className="portfolio-bar-row" key={item.symbol}><strong>{item.symbol}</strong><span className={item.value < 0 ? 'bar-track negative' : 'bar-track'}><i style={{ width: `${max ? Math.abs(item.value) / max * 100 : 0}%` }} /></span><small className={valueTone(item.value)}>{mode === 'weight' ? formatPercent(item.value) : formatSignedMoney(item.value)}</small></div>) : <p className="chart-empty">行情可用后显示</p>}</section>
}

function ReduceDialog({ position, cash, onCancel, onSubmit }: { position: PortfolioPosition; cash: number; onCancel: () => void; onSubmit: (quantity: number, price: number) => Promise<void> }) {
  const [quantity, setQuantity] = useState('')
  const [price, setPrice] = useState(position.marketPrice === null ? '' : String(position.marketPrice))
  const shares = Number(quantity), salePrice = Number(price), valid = Number.isFinite(shares) && shares > 0 && shares <= position.quantity && Number.isFinite(salePrice) && salePrice >= 0
  const proceeds = valid ? shares * salePrice : 0, realized = valid ? (salePrice - position.averageCost) * shares : 0
  return <div className="portfolio-modal"><form role="dialog" aria-modal="true" aria-label={`减仓 ${position.symbol}`} onSubmit={(event) => { event.preventDefault(); if (valid) void onSubmit(shares, salePrice) }}><p className="micro">REDUCE POSITION</p><h2>减仓 {position.symbol}</h2><p>当前持有 {formatNumber(position.quantity)} 股，平均成本 {formatMoney(position.averageCost)}。</p><label>卖出数量<input autoFocus aria-label="卖出数量" type="number" min="0.000001" max={position.quantity} step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} required /></label><label>成交价<input aria-label="成交价" type="number" min="0" step="any" value={price} onChange={(event) => setPrice(event.target.value)} required /></label><div className="trade-preview"><span>卖出所得<strong>{valid ? formatMoney(proceeds) : '—'}</strong></span><span>减仓后现金<strong>{valid ? formatMoney(cash + proceeds) : '—'}</strong></span><span>本次已实现盈亏<strong className={valueTone(realized)}>{valid ? formatSignedMoney(realized) : '—'}</strong></span></div>{shares > position.quantity && <p role="alert" className="missing">卖出数量不能超过当前持仓。</p>}<div className="modal-actions"><button type="button" className="quiet" onClick={onCancel}>取消</button><button type="submit" disabled={!valid}>确认减仓</button></div></form></div>
}

function SettingsPage({ health, modelConfigured, settings, onReload }: {
  health: SystemHealth | null; modelConfigured: boolean; settings: RuntimeSettingsResponse | null
  onReload: () => Promise<void>
}) {
  const [writeError, setWriteError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const fields: Array<{ key: keyof RuntimeSettings; label: string }> = [
    { key: 'mainAgentToolRounds', label: '主 Agent 轮次' },
    { key: 'specialistAgentToolRounds', label: '专项 Agent 轮次' },
    { key: 'researchActiveMinutes', label: '研究时长（分钟）' },
    { key: 'executionWallClockMinutes', label: 'Execution 墙钟（分钟）' },
    { key: 'analysisConcurrency', label: '研究并发' },
    { key: 'modelConcurrency', label: '模型并发' },
    { key: 'toolConcurrency', label: '工具并发' },
    { key: 'modelRequestTimeoutMinutes', label: '模型请求超时（分钟）' },
    { key: 'reportFreshnessDays', label: 'Freshness（天）' },
    { key: 'compactionReserveTokens', label: 'Compaction 保留 Token' },
  ]
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const body = Object.fromEntries(fields.map(({ key }) => [key, Number(data.get(key))]))
    await writeSettings('Runtime 设置保存失败', '/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
  }
  async function restoreDefaults() {
    await writeSettings('Runtime 设置恢复失败', '/api/settings/defaults', { method: 'POST' })
  }
  async function restoreField(key: keyof RuntimeSettings) {
    await writeSettings('Runtime 设置恢复失败', '/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [key]: settings!.defaults[key] }),
    })
  }
  async function writeSettings(message: string, url: string, init: RequestInit) {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setWriteError('')
    try {
      const response = await fetch(url, init)
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null
        const detail = typeof body?.error === 'string' ? `：${body.error}` : ''
        throw new Error(`${message}（HTTP ${response.status}）${detail}`)
      }
      await onReload()
    } catch (cause) {
      setWriteError(cause instanceof Error ? cause.message : message)
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }
  return <><PageHeader eyebrow="INSTANCE SETTINGS" title="系统设置" description="普通 Runtime 设置保存在 PostgreSQL；密钥值永远不会返回浏览器。" /><div className="settings-grid"><Setting title="Analysis API" description="分析任务、研究记录与持仓管理" ready={health?.status === 'ok'} /><Setting title="Financial Data" description="行情、新闻、财报与确定性计算" ready={health?.dependencies.financialData.status === 'ok'} /><Setting title="AI Model" description="由 .env 指定的兼容模型端点" ready={modelConfigured} /><Setting title="PostgreSQL" description="持仓、权益历史、事实与研究轨迹" ready={health?.dependencies.productDatabase.status === 'ok'} /></div>{settings?.current && settings.defaults && <section className="runtime-settings" aria-busy={submitting}><header><div><p className="micro">AGENT RUNTIME</p><h2>当前 revision #{settings.current.id}</h2><p>上次修改：{formatTime(settings.current.createdAt)}</p></div><button type="button" className="quiet" disabled={submitting} onClick={() => void restoreDefaults()}>恢复全部默认值</button></header>{writeError && <p role="alert" className="error-banner">{writeError}</p>}<form key={settings.current.id} onSubmit={(event) => void save(event)}>{fields.map(({ key, label }) => <label key={key}>{label}<input aria-label={label} name={key} type="number" min={runtimeSettingLimits[key][0]} max={runtimeSettingLimits[key][1]} defaultValue={settings.current!.values[key]} disabled={submitting} required /><small>默认 {settings.defaults![key].toLocaleString('zh-CN')} <button type="button" className="text-button" disabled={submitting} onClick={() => void restoreField(key)}>恢复此项</button></small></label>)}<button type="submit" disabled={submitting}>{submitting ? '保存中…' : '保存 Runtime 设置'}</button></form>{settings.activeExecutions.length > 0 && <div className="frozen-settings"><h3>运行中的冻结值</h3>{settings.activeExecutions.map((snapshot) => <article key={snapshot.executionId}><strong>运行 execution {snapshot.executionId}</strong><span>{formatFrozenSettings(snapshot.values)}</span></article>)}</div>}</section>}</>
}

function formatFrozenSettings(settings: RuntimeSettings) {
  return `主 Agent ${settings.mainAgentToolRounds} 轮 · 专项 ${settings.specialistAgentToolRounds} 轮 · 研究 ${settings.researchActiveMinutes} 分钟 · 墙钟 ${settings.executionWallClockMinutes} 分钟 · 研究/模型/工具并发 ${settings.analysisConcurrency}/${settings.modelConcurrency}/${settings.toolConcurrency} · 模型超时 ${settings.modelRequestTimeoutMinutes} 分钟 · Freshness ${settings.reportFreshnessDays} 天 · Compaction 保留 ${settings.compactionReserveTokens.toLocaleString('zh-CN')} Token`
}

function PriceChart({ facts, compact = false }: { facts: Fact[]; compact?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const bars = normalizedBars(facts).slice(compact ? -30 : -60)
  useEffect(() => { if (canvas.current) drawPriceChart(canvas.current, bars, compact) }, [facts, compact])
  if (bars.length < 2) return <div className="chart-empty">暂无足够历史行情</div>
  return <figure className={compact ? 'price-chart compact' : 'price-chart'}><canvas ref={canvas} role="img" aria-label={`${bars[0].date} 至 ${bars.at(-1)?.date} 的收盘价与成交量趋势`} /><figcaption><span>{bars[0].date}</span><span>收盘价与成交量</span><span>{bars.at(-1)?.date}</span></figcaption></figure>
}

function ValuationView({ fact, explanation }: { fact: Fact; explanation?: string | null }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const value = asRecord(fact.value)
  const currentMultiples = asRecord(value.current_multiples)
  const ranges = asRecord(value.historical_ranges)
  const historical = Array.isArray(ranges.pe) ? ranges.pe.map(Number) : []
  const multiple = Number(currentMultiples.pe)
  useEffect(() => { if (canvas.current) drawValuation(canvas.current, multiple, historical) }, [multiple, historical.join(',')])
  return <div className="valuation-view"><div><strong>{Number.isFinite(multiple) ? `${multiple.toFixed(1)}×` : '不可用'}</strong><span>当前 PE</span><p>{explanation ?? '估值仅作为区间参考，不单独构成买卖依据。'}</p></div>{Number.isFinite(multiple) && historical.length === 2 ? <figure><canvas ref={canvas} role="img" aria-label={`当前 PE ${multiple.toFixed(1)} 倍，历史区间 ${historical[0].toFixed(1)} 至 ${historical[1].toFixed(1)} 倍`} /><figcaption>当前 PE 与自身历史区间</figcaption></figure> : <p className="chart-empty">历史估值区间不可用</p>}</div>
}

function Evidence({ facts, ids }: { facts: Map<string, Fact>; ids: string[] }) {
  return <ul className="evidence-list">{ids.map((id) => { const fact = facts.get(id); return fact ? <li key={id}><FactCard fact={fact} /></li> : <li key={id} className="missing">这条依据已经不可用</li> })}</ul>
}
function FactCard({ fact }: { fact: Fact }) {
  const href = safeReference(fact.sourceReference)
  const content = <><span className="fact-kind">{factLabel(fact.type)}</span><strong>{factHeadline(fact)}</strong><small>{fact.source} · {formatTime(fact.observedAt)}</small></>
  return href ? <a className="fact-card" href={href} target="_blank" rel="noreferrer">{content}</a> : <div className="fact-card">{content}</div>
}

function TraceSummary({ trace }: { trace: Array<Record<string, unknown>> }) {
  const stages = [
    ['system_prompt', '载入分析规则'], ['financial_context', '冻结金融上下文'], ['tool_call', '调用只读工具'],
    ['tool_result', '工具返回事实'], ['model_completed', '生成结构化报告'], ['status', '保存任务状态'],
  ] as const
  const financialContext = trace.find((entry) => entry.type === 'financial_context')
  const capabilities = Array.isArray(financialContext?.capabilities)
    ? financialContext.capabilities.map(asRecord)
    : []
  return <aside className="trace-panel"><p className="micro">分析轨迹</p>{stages.map(([type, label], index) => { const entries = trace.filter((entry) => entry.type === type); const count = entries.length; const expandable = type === 'financial_context' && capabilities.length > 0; return expandable ? <details className="trace-stage" key={type}><summary><i>{index + 1}</i><span>{label}</span><small>{count} 次</small></summary><div className="source-diagnostics">{capabilities.map((capability) => <CapabilityTrace key={String(capability.capability)} capability={capability} />)}</div></details> : <div key={type}><i>{index + 1}</i><span>{label}</span><small>{count ? `${count} 次` : '无'}</small></div> })}<details><summary>开发者信息</summary><p>底层共保存 {trace.length} 条原始事件，用于排查和审计；此处不逐条渲染模型 token。</p></details></aside>
}

function CapabilityTrace({ capability }: { capability: Record<string, unknown> }) {
  const sources = Array.isArray(capability.sources) ? capability.sources.map(asRecord) : []
  const acceptedCount = Number(capability.acceptedCount ?? 0)
  const adopted = typeof capability.adoptedSource === 'string' ? capability.adoptedSource : null
  return <details><summary><span>{capabilityLabel(String(capability.capability))}</span><small>{adopted ? `采用 ${adopted}` : '未采用来源'} · {acceptedCount} 条</small></summary><ul>{sources.map((source) => { const status = String(source.status ?? 'unknown'); const count = Number(source.item_count ?? 0); return <li key={String(source.source)}><strong>{String(source.source)}</strong><span className={`source-${status}`}>{sourceStatusLabel(status)}</span><small>{status === 'failed' ? String(source.error ?? '未知错误') : `${count} 条`}</small></li> })}</ul></details>
}

function capabilityLabel(value: string) { return ({ quote: '当前行情', history: '历史行情', news: '近期新闻', fundamentals: '财报基本面', valuation: '估值数据' } as Record<string, string>)[value] ?? value }
function sourceStatusLabel(value: string) { return ({ ok: '成功', empty: '空结果', failed: '失败' } as Record<string, string>)[value] ?? value }

function formatAnalysisDate(value?: string) {
  if (!value) return '时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
}

function ReportBlock({ number, title, children }: { number: string; title: string; children: ReactNode }) { return <section className="report-block"><header><span>{number}</span><h3>{title}</h3></header><div>{children}</div></section> }
function BulletList({ values }: { values: string[] }) { return <ul className="plain-list">{values.map((value, index) => <li key={index}>{value}</li>)}</ul> }
function Metric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div> }
function StatusRow({ label, ready }: { label: string; ready: boolean }) { return <div className="status-row"><i className={ready ? 'live-dot' : 'live-dot off'} /><span>{label}</span><small>{ready ? '正常' : '不可用'}</small></div> }
function SystemBadge({ health, modelConfigured }: { health: SystemHealth | null; modelConfigured: boolean }) { const ready = health?.status === 'ok' && modelConfigured; return <div className="system-badge"><i className={ready ? 'live-dot' : 'live-dot off'} /><span>本地实例</span><small>{ready ? '全部正常' : '能力受限'}</small></div> }
function Setting({ title, description, ready }: { title: string; description: string; ready: boolean }) { return <section><div><p className="micro">INSTANCE CAPABILITY</p><h2>{title}</h2><p>{description}</p></div><span className={ready ? 'ready-chip' : 'ready-chip off'}><i />{ready ? '正常' : '不可用'}</span></section> }

function normalizedBars(facts: Fact[]) {
  const map = new Map<string, { date: string; close: number; volume: number }>()
  for (const fact of facts.filter((item) => item.type === 'daily_bar')) {
    const value = asRecord(fact.value), date = String(value.date ?? fact.observedAt).slice(0, 10), close = Number(value.close), volume = Number(value.volume)
    if (Number.isFinite(close) && (!map.has(date) || fact.source.toLowerCase() === 'yahoo')) map.set(date, { date, close, volume: Number.isFinite(volume) ? volume : 0 })
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}
function drawPriceChart(canvas: HTMLCanvasElement, bars: ReturnType<typeof normalizedBars>, compact: boolean) {
  const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1, width = Math.max(rect.width, 320), height = compact ? 150 : 260
  canvas.width = width * ratio; canvas.height = height * ratio; canvas.style.height = `${height}px`
  const ctx = canvas.getContext('2d'); if (!ctx) return; ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height)
  const pad = { x: 12, top: 18, bottom: 38 }, plotHeight = height - pad.top - pad.bottom
  const closes = bars.map((item) => item.close), min = Math.min(...closes), max = Math.max(...closes), range = max - min || 1
  const points = bars.map((item, index) => ({ x: pad.x + index * ((width - pad.x * 2) / (bars.length - 1)), y: pad.top + (max - item.close) / range * (plotHeight * .72) }))
  ctx.strokeStyle = '#d8d1c4'; ctx.lineWidth = 1; for (let row = 0; row < 3; row += 1) { const y = pad.top + row * plotHeight * .36; ctx.beginPath(); ctx.moveTo(pad.x, y); ctx.lineTo(width - pad.x, y); ctx.stroke() }
  ctx.strokeStyle = '#e25132'; ctx.lineWidth = 2.5; ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.stroke()
  const maxVolume = Math.max(...bars.map((item) => item.volume), 1); ctx.fillStyle = '#bbb3a7'; const barWidth = Math.max(1, (width - pad.x * 2) / bars.length - 2)
  bars.forEach((item, index) => { const h = item.volume / maxVolume * (plotHeight * .2); ctx.fillRect(points[index].x - barWidth / 2, height - pad.bottom - h, barWidth, h) })
  ctx.fillStyle = '#766f66'; ctx.font = '11px system-ui'; ctx.fillText(formatMoney(max), pad.x, 12); ctx.fillText(formatMoney(min), pad.x, plotHeight * .72 + pad.top + 14)
}
function drawValuation(canvas: HTMLCanvasElement, current: number, historical: number[]) {
  const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1, width = Math.max(rect.width, 280), height = 100
  canvas.width = width * ratio; canvas.height = height * ratio; canvas.style.height = `${height}px`; const ctx = canvas.getContext('2d'); if (!ctx) return; ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height)
  const max = Math.max(current, historical[1]) * 1.12, x = (value: number) => 18 + value / max * (width - 36)
  ctx.strokeStyle = '#c9c1b5'; ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x(historical[0]), 50); ctx.lineTo(x(historical[1]), 50); ctx.stroke()
  ctx.fillStyle = '#e25132'; ctx.beginPath(); ctx.arc(x(current), 50, 7, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#5f584f'; ctx.font = '11px system-ui'; ctx.fillText(`${historical[0].toFixed(1)}×`, x(historical[0]) - 14, 78); ctx.fillText(`${historical[1].toFixed(1)}×`, x(historical[1]) - 14, 78); ctx.fillStyle = '#e25132'; ctx.fillText(`${current.toFixed(1)}×`, Math.min(x(current) - 14, width - 45), 28)
}
const chartColors = ['#e25132', '#24201b', '#80776d', '#b19d80', '#77906f', '#d0c7ba']
function drawAllocationDonut(canvas: HTMLCanvasElement, segments: Array<{ label: string; value: number }>) {
  const ratio = window.devicePixelRatio || 1, size = 220
  canvas.width = size * ratio; canvas.height = size * ratio; canvas.style.width = `${size}px`; canvas.style.height = `${size}px`
  const ctx = canvas.getContext('2d'); if (!ctx) return; ctx.scale(ratio, ratio); ctx.clearRect(0, 0, size, size)
  const total = segments.reduce((sum, item) => sum + item.value, 0)
  let angle = -Math.PI / 2
  segments.forEach((item, index) => { const next = angle + item.value / total * Math.PI * 2; ctx.beginPath(); ctx.strokeStyle = chartColors[index % chartColors.length]; ctx.lineWidth = 28; ctx.arc(size / 2, size / 2, 72, angle + .015, next - .015); ctx.stroke(); angle = next })
  ctx.fillStyle = '#756d64'; ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.fillText('组合总值', size / 2, size / 2 - 5)
  ctx.fillStyle = '#211d18'; ctx.font = '700 17px system-ui'; ctx.fillText(formatNullableMoney(total), size / 2, size / 2 + 19)
}
function drawEquityHistory(canvas: HTMLCanvasElement, points: PortfolioEquitySnapshot[]) {
  const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1
  const width = Math.max(rect.width, 640), height = 250
  canvas.width = width * ratio; canvas.height = height * ratio; canvas.style.height = `${height}px`
  const ctx = canvas.getContext('2d'); if (!ctx) return; ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height)
  const values = points.map((item) => item.totalEquity), min = Math.min(...values), max = Math.max(...values), range = max - min || Math.max(max * .02, 1)
  const pad = { left: 12, right: 72, top: 22, bottom: 28 }, plotWidth = width - pad.left - pad.right, plotHeight = height - pad.top - pad.bottom
  const coords = points.map((item, index) => ({ x: pad.left + index * (plotWidth / Math.max(points.length - 1, 1)), y: pad.top + (max - item.totalEquity) / range * plotHeight }))
  ctx.strokeStyle = '#ddd5c9'; ctx.lineWidth = 1
  for (let row = 0; row < 4; row += 1) { const y = pad.top + row * plotHeight / 3; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke() }
  const fill = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom); fill.addColorStop(0, '#e2513240'); fill.addColorStop(1, '#e2513205')
  ctx.beginPath(); coords.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.lineTo(coords.at(-1)!.x, height - pad.bottom); ctx.lineTo(coords[0].x, height - pad.bottom); ctx.closePath(); ctx.fillStyle = fill; ctx.fill()
  ctx.beginPath(); coords.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.strokeStyle = '#e25132'; ctx.lineWidth = 2.5; ctx.stroke()
  const latest = coords.at(-1)!; ctx.fillStyle = '#e25132'; ctx.beginPath(); ctx.arc(latest.x, latest.y, 4, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#736b62'; ctx.font = '10px Inter, system-ui'; ctx.fillText(formatMoney(max), width - pad.right + 9, pad.top + 4); ctx.fillText(formatMoney(min), width - pad.right + 9, height - pad.bottom)
}

function factHeadline(fact: Fact) {
  const value = asRecord(fact.value)
  if (fact.type === 'quote') return formatMoney(Number(fact.value))
  if (fact.type === 'daily_bar') return `${String(value.date ?? fact.observedAt).slice(0, 10)} · 收 ${formatMoney(Number(value.close))} · 成交量 ${formatCompact(Number(value.volume))}`
  if (fact.type === 'news') return String(value.title ?? value.summary ?? '新闻条目')
  if (fact.type === 'indicators') return `MA5 ${formatMaybeMoney(value.ma_5)} · MA20 ${formatMaybeMoney(value.ma_20)} · RSI ${formatMaybeNumber(value.rsi_14)}`
  if (fact.type === 'valuation') { const multiples = asRecord(value.current_multiples); return `当前 PE ${formatMaybeNumber(multiples.pe)}× · 可比公司 ${Array.isArray(value.comparable_symbols) && value.comparable_symbols.length ? value.comparable_symbols.join('、') : '不适用'}` }
  if (typeof fact.value === 'number') return formatCompact(fact.value)
  return String(value.title ?? value.name ?? value.status ?? '结构化事实')
}
function asRecord(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {} }
function pipelineIndex(status: string, stages: string[]) { if (['completed', 'partial'].includes(status)) return 6; if (status === 'failed' || status === 'cancelled' || status === 'interrupted') return Math.max(0, stages.includes('model_event') ? 4 : stages.includes('financial_context') ? 3 : 1); return stages.includes('model_completed') ? 5 : stages.includes('model_event') ? 4 : stages.includes('financial_context') ? 3 : status === 'running' ? 2 : status === 'queued' ? 1 : 0 }
function pipelineLabel(stage: string) { return ({ queued: '创建分析任务', running: '准备市场与持仓材料', financial_context: '冻结金融上下文', model_event: 'AI 综合判断', model_completed: '校验结构化报告', completed: '保存研究记录' } as Record<string, string>)[stage] }
function safeReference(value: string) { return value.startsWith('http://') || value.startsWith('https://') ? value : undefined }
function factLabel(type: string) { return ({ quote: '当前价格', daily_bar: '历史行情', news: '相关新闻', indicators: '技术指标', valuation: '估值结果', dilutedEps: '每股收益', revenue: '营业收入', netIncome: '净利润', operatingCashFlow: '经营现金流' } as Record<string, string>)[type] ?? '结构化事实' }
function statusLabel(status: string) { return ({ queued: '排队中', running: '分析中', completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '服务中断' } as Record<string, string>)[status] ?? status }
function trendVerdict(trend?: string) { if (!trend) return '受限'; if (/偏强|看涨|上升/.test(trend)) return '谨慎偏多'; if (/偏弱|看跌|下降/.test(trend)) return '谨慎偏空'; return '中性观察' }
function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) }
function formatMoney(value: number) { return Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value) : '—' }
function formatNullableMoney(value: number | null) { return value === null ? '不可用' : formatMoney(value) }
function formatSignedMoney(value: number | null) { if (value === null || !Number.isFinite(value)) return '不可用'; return `${value > 0 ? '+' : ''}${formatMoney(value)}` }
function formatSignedMoneyOrDash(value: number | null) { return value === null ? '—' : formatSignedMoney(value) }
function formatNumber(value: number) { return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value) }
function formatCompact(value: number) { return Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(value) : '—' }
function formatMaybeMoney(value: unknown) { return formatMoney(Number(value)) }
function formatMaybeNumber(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number.toFixed(2) : '—' }
function formatPercent(value: unknown) { const number = Number(value); return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : '—' }
function formatSignedPercent(value: number) { return `${value > 0 ? '+' : ''}${(value * 100).toFixed(2)}%` }
function formatSignedPercentOrDash(value: number | null) { return value === null ? '—' : formatSignedPercent(value) }
function valueTone(value?: number | null) { return value === undefined || value === null || value === 0 ? '' : value > 0 ? 'positive' : 'negative' }
function emptyPortfolio(): PortfolioOverview { return { cash: 0, totalCost: 0, totalMarketValue: 0, totalEquity: 0, totalUnrealizedProfitLoss: 0, totalUnrealizedReturn: null, pricedPositionCount: 0, unpricedPositionCount: 0, positions: [] } }
function friendlyError(value: string) { if (value.startsWith('unknown_evidence:')) return 'AI 引用了一条不存在的报告依据，本次报告已被拒绝。'; if (value.includes('report_tool_required')) return 'AI 没有返回规定格式的报告，本次分析未保存为完成报告。'; if (value.includes('model_not_configured')) return '尚未配置 AI 模型，暂时不能创建新分析。'; if (value.includes('model_')) return 'AI 模型调用失败，请检查模型配置后重试。'; if (value.includes('financial_context')) return '金融数据格式不完整，本次分析已停止以避免生成错误结论。'; return `分析没有完成：${value}` }

function isReportOlderThan(createdAt: string | null | undefined, freshnessDays: number) {
  if (!createdAt) return false
  const createdTime = Date.parse(createdAt)
  return Number.isFinite(createdTime) && Date.now() - createdTime > freshnessDays * 86_400_000
}
