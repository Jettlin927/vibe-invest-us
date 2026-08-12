import { useEffect, useState, type ReactNode } from 'react'

// PROTOTYPE — 可丢弃。
// 问题：第一阶段五项核心能力应如何拆成多页面工作台？三个方案通过 ?variant=A|B|C 切换。

type Page = 'overview' | 'analysis' | 'research' | 'portfolio' | 'settings'
type Variant = 'A' | 'B' | 'C'

const pages: Array<{ id: Page; label: string; short: string }> = [
  { id: 'overview', label: '总览', short: '今日' },
  { id: 'analysis', label: '新建分析', short: '分析' },
  { id: 'research', label: '研究记录', short: '研究' },
  { id: 'portfolio', label: '我的持仓', short: '持仓' },
  { id: 'settings', label: '系统设置', short: '设置' },
]

const variants: Array<{ id: Variant; name: string }> = [
  { id: 'A', name: '投资驾驶舱' },
  { id: 'B', name: '研究简报' },
  { id: 'C', name: '分析工作台' },
]

export function WorkbenchPrototype() {
  const params = new URLSearchParams(window.location.search)
  const initialVariant = variants.some((item) => item.id === params.get('variant'))
    ? params.get('variant') as Variant : 'A'
  const initialPage = pages.some((item) => item.id === params.get('page'))
    ? params.get('page') as Page : 'overview'
  const [variant, setVariant] = useState<Variant>(initialVariant)
  const [page, setPage] = useState<Page>(initialPage)

  useEffect(() => {
    const originalTitle = document.title
    document.title = 'Vibe Invest · 工作台原型'
    return () => { document.title = originalTitle }
  }, [])

  function update(nextVariant: Variant, nextPage = page) {
    const next = new URL(window.location.href)
    next.searchParams.set('variant', nextVariant)
    next.searchParams.set('page', nextPage)
    window.history.replaceState(null, '', next)
    setVariant(nextVariant)
    setPage(nextPage)
  }

  function openPage(nextPage: Page) {
    update(variant, nextPage)
  }

  function cycle(direction: -1 | 1) {
    const current = variants.findIndex((item) => item.id === variant)
    update(variants[(current + direction + variants.length) % variants.length].id)
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, [contenteditable="true"]')) return
      if (event.key === 'ArrowLeft') cycle(-1)
      if (event.key === 'ArrowRight') cycle(1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <div className={`wb-prototype variant-${variant.toLowerCase()}`}>
      {variant === 'A' && <VariantA page={page} onNavigate={openPage} />}
      {variant === 'B' && <VariantB page={page} onNavigate={openPage} />}
      {variant === 'C' && <VariantC page={page} onNavigate={openPage} />}
      <PrototypeSwitcher variant={variant} onCycle={cycle} />
    </div>
  )
}

function VariantA({ page, onNavigate }: PrototypeViewProps) {
  return (
    <div className="a-shell">
      <aside className="a-sidebar">
        <Brand compact />
        <Nav page={page} onNavigate={onNavigate} />
        <div className="a-system"><span className="live-dot" />三项服务正常<small>本地实例 · 已连接</small></div>
      </aside>
      <main className="a-main">
        <PageHeader page={page} eyebrow="PERSONAL INTELLIGENCE" />
        <PageContent page={page} mode="dashboard" onNavigate={onNavigate} />
      </main>
    </div>
  )
}

function VariantB({ page, onNavigate }: PrototypeViewProps) {
  return (
    <div className="b-shell">
      <header className="b-header">
        <Brand />
        <Nav page={page} onNavigate={onNavigate} />
        <SystemBadge />
      </header>
      <main className="b-main">
        <PageHeader page={page} eyebrow="12 AUGUST 2026 · SHANGHAI" />
        <PageContent page={page} mode="editorial" onNavigate={onNavigate} />
      </main>
    </div>
  )
}

function VariantC({ page, onNavigate }: PrototypeViewProps) {
  return (
    <div className="c-shell">
      <aside className="c-rail">
        <Brand compact />
        <Nav page={page} onNavigate={onNavigate} />
      </aside>
      <main className="c-main">
        <div className="c-command">
          <span>⌘</span><input aria-label="快速查找" placeholder="搜索标的、报告或命令…" /><kbd>⌘ K</kbd>
        </div>
        <PageHeader page={page} eyebrow="WORKSPACE / LOCAL" />
        <PageContent page={page} mode="workspace" onNavigate={onNavigate} />
      </main>
      <aside className="c-context">
        <p className="micro">当前上下文</p>
        <h3>NVDA</h3>
        <strong>$181.42</strong><span className="positive">+2.36%</span>
        <MiniChart />
        <dl><dt>持仓</dt><dd>36 股</dd><dt>组合占比</dt><dd>18.4%</dd><dt>数据时间</dt><dd>16:00 ET</dd></dl>
        <p className="context-note">所有页面共享当前研究对象，但报告只引用冻结快照。</p>
      </aside>
    </div>
  )
}

type PrototypeViewProps = { page: Page; onNavigate: (page: Page) => void }

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><b>V{compact ? '' : 'IBE'}<i>•</i></b>{!compact && <span>INVEST</span>}</div>
}

function Nav({ page, onNavigate }: PrototypeViewProps) {
  return <nav className="wb-nav" aria-label="主导航">{pages.map((item, index) => (
    <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => onNavigate(item.id)}>
      <span>{String(index + 1).padStart(2, '0')}</span>{item.label}
    </button>
  ))}</nav>
}

const pageTitles: Record<Page, { title: string; description: string }> = {
  overview: { title: '今天，先看重要的。', description: '把系统状态、最新研究和个人相关性放在一个安静的起点。' },
  analysis: { title: '发起一次有依据的分析', description: '选择标的，观察取数、降级与 AI 判断的全过程。' },
  research: { title: '研究不是答案，是可回放的判断。', description: '重新打开报告，逐条核对事实、反证、情景与失效条件。' },
  portfolio: { title: '让公共信息回到你的持仓语境', description: '手工维护数量与成本；没有持仓也不妨碍公共分析。' },
  settings: { title: '能力状态，而不是密钥仓库', description: '只展示模型和金融数据能力是否可用，凭据仍由服务端环境提供。' },
}

function PageHeader({ page, eyebrow }: { page: Page; eyebrow: string }) {
  const content = pageTitles[page]
  return <header className="page-header"><p className="micro">{eyebrow}</p><h1>{content.title}</h1><p>{content.description}</p></header>
}

function PageContent({ page, mode, onNavigate }: { page: Page; mode: 'dashboard' | 'editorial' | 'workspace'; onNavigate: (page: Page) => void }) {
  if (page === 'analysis') return <AnalysisPage mode={mode} />
  if (page === 'research') return <ResearchPage mode={mode} />
  if (page === 'portfolio') return <PortfolioPage />
  if (page === 'settings') return <SettingsPage />
  return <OverviewPage mode={mode} onNavigate={onNavigate} />
}

function OverviewPage({ mode, onNavigate }: { mode: string; onNavigate: (page: Page) => void }) {
  return <div className={`overview-layout ${mode}`}>
    <section className="hero-card">
      <div><p className="micro">最近一次分析 · 14:32</p><h2>NVDA：强势结构延续，估值约束仍在</h2><p>价格维持在 20 日均线上方，AI 基础设施需求提供支撑；但前向估值高于同业中位数，需等待下一份财报验证。</p></div>
      <div className="conviction"><span>倾向</span><strong>谨慎偏多</strong><small>未来 1—4 周</small></div>
      <button onClick={() => onNavigate('research')}>打开完整报告 <span>↗</span></button>
    </section>
    <section className="market-card">
      <p className="micro">当前标的</p><div className="quote"><div><h3>NVDA</h3><span>NASDAQ</span></div><div><strong>$181.42</strong><span className="positive">+2.36%</span></div></div>
      <MiniChart />
      <div className="metrics"><Metric label="RSI 14" value="61.8" /><Metric label="20D 趋势" value="向上" /><Metric label="波动率" value="38.2%" /></div>
    </section>
    <section className="portfolio-card"><p className="micro">个人相关性</p><h3>组合中的 NVDA</h3><strong className="big-number">18.4%</strong><p>36 股 · 平均成本 $134.20<br />未实现盈亏 <span className="positive">+$1,700</span></p><button className="ghost" onClick={() => onNavigate('portfolio')}>查看持仓</button></section>
    <section className="status-card"><p className="micro">实例能力</p><StatusRow label="Analysis API" detail="8 ms" /><StatusRow label="金融数据" detail="2 个来源" /><StatusRow label="AI 模型" detail="已配置" /></section>
    <section className="history-card"><p className="micro">最近研究</p><HistoryRow symbol="MSFT" title="云业务韧性与 AI 资本开支" time="昨天" /><HistoryRow symbol="MU" title="存储周期进入利润兑现阶段" time="8 月 10 日" /><HistoryRow symbol="AMZN" title="零售利润改善，云增长待确认" time="8 月 08 日" /></section>
  </div>
}

function AnalysisPage({ mode }: { mode: string }) {
  const [running, setRunning] = useState(false)
  return <div className={`analysis-layout ${mode}`}>
    <section className="analysis-start"><p className="micro">01 / 选择研究对象</p><label>美股代码<div className="symbol-input"><input defaultValue="NVDA" aria-label="美股代码" /><button onClick={() => setRunning(true)}>{running ? '分析进行中…' : '开始分析'} <span>→</span></button></div></label><p className="hint">分析窗口：未来 1—4 周 · 会自动加入当前持仓语境</p></section>
    <section className="pipeline"><p className="micro">02 / 分析链路</p>{['创建任务', '冻结行情与财报', '核验双新闻源', '计算指标与估值', 'AI 综合判断', '保存研究记录'].map((label, index) => <div className={running && index < 4 ? 'done' : running && index === 4 ? 'active' : ''} key={label}><i>{index < 4 && running ? '✓' : index + 1}</i><span>{label}</span><small>{running && index < 4 ? `${index + 1}.${index + 2}s` : index === 4 && running ? '正在生成' : '等待'}</small></div>)}</section>
    <section className="source-health"><p className="micro">本次所需能力</p><StatusRow label="当前行情 / 历史行情" detail="主源可用" /><StatusRow label="财报与估值输入" detail="SEC 可用" /><StatusRow label="近实时新闻" detail="2 / 2 可用" /><StatusRow label="个人持仓" detail="已匹配" /><p className="callout">数据缺失时，依赖该数据的结论会关闭，并在报告中明确说明。</p></section>
  </div>
}

function ResearchPage({ mode }: { mode: string }) {
  return <div className={`research-page ${mode}`}>
    <aside className="research-index"><p className="micro">研究记录 · 12</p>{['NVDA','MSFT','MU','AMZN'].map((symbol, index) => <button className={index === 0 ? 'active' : ''} key={symbol}><strong>{symbol}</strong><span>{['谨慎偏多','中性','偏多','中性'][index]}</span><small>{index ? `${index + 7} 月` : '今天 14:32'}</small></button>)}</aside>
    <article className="research-report"><div className="report-title"><div><p className="micro">NVDA · 已完成 · 快照 #A82F</p><h2>强势结构延续，估值约束仍在</h2></div><span className="verdict">谨慎偏多<small>1—4 周</small></span></div><ReportBlock number="01" title="关键判断"><p>需求与盈利预期仍支持中期叙事，但短期上涨已经计入较高预期，风险收益比不适合追逐。</p><Evidence text="收盘价 $181.42，高于 MA20 的 $168.70" source="NASDAQ · 08/11 16:00 ET" /><Evidence text="数据中心收入同比增长 56%" source="SEC 10-Q · 07/30" /></ReportBlock><ReportBlock number="02" title="相反证据"><p>前向 PE 高于同业中位数 42%，若毛利率指引走弱，估值压缩可能快于盈利兑现。</p></ReportBlock><ReportBlock number="03" title="情景与失效条件"><div className="scenario-row"><span>上行情景<strong>突破 $190 且放量</strong></span><span>基准情景<strong>$168—190 震荡</strong></span><span>失效条件<strong>跌破 MA50</strong></span></div></ReportBlock></article>
    <aside className="trace-panel"><p className="micro">分析轨迹 · 18 步</p>{['载入分析规则','冻结金融上下文','读取 SEC 财报','检索相关新闻','生成结构化报告','依据校验通过'].map((item, index) => <div key={item}><i>{index + 1}</i><span>{item}</span><small>14:{32 + index}</small></div>)}<button className="ghost">展开完整轨迹</button></aside>
  </div>
}

function PortfolioPage() {
  return <div className="portfolio-page"><section className="portfolio-summary"><p className="micro">组合摘要</p><strong>$35,860</strong><span className="positive">今日 +1.26% · +$446</span><div className="allocation"><i style={{ width: '42%' }} /><i style={{ width: '24%' }} /><i style={{ width: '18%' }} /><i style={{ width: '16%' }} /></div><small>集中度：前三大持仓占 72.8%</small></section><section className="position-table"><div className="table-head"><span>标的</span><span>数量 / 成本</span><span>市值</span><span>盈亏</span></div>{[['NVDA','36 · $134.20','$6,531','+35.2%'],['MSFT','18 · $402.40','$7,485','+3.3%'],['MU','42 · $118.60','$5,934','+19.1%']].map((row) => <div className="table-row" key={row[0]}>{row.map((cell, index) => <span className={index === 3 ? 'positive' : ''} key={cell}>{cell}</span>)}</div>)}</section><section className="position-form"><p className="micro">新增或更新持仓</p><label>股票代码<input defaultValue="NVDA" /></label><label>数量<input placeholder="36" /></label><label>平均成本<input placeholder="$134.20" /></label><button>保存持仓</button><p className="hint">持仓仅保存在你的自托管实例中。</p></section></div>
}

function SettingsPage() {
  return <div className="settings-page"><section><p className="micro">运行状态</p><h2>所有核心能力均可用</h2><p>系统只读取服务端配置状态，不在页面显示或保存密钥。</p></section>{[['AI 模型','Anthropic · 已配置','用于生成结构化分析报告'],['行情与历史数据','主源 + 备用源','来源失败时自动切换并展示降级'],['财报数据','SEC Company Facts','估值输入不完整时关闭对应方法'],['近实时新闻','2 个来源可用','保留发布时间、取得时间与原文链接']].map(([title, value, desc]) => <section className="setting-row" key={title}><div><p className="micro">{title}</p><h3>{value}</h3><p>{desc}</p></div><span className="ready-chip"><i /> 正常</span></section>)}</div>
}

function PrototypeSwitcher({ variant, onCycle }: { variant: Variant; onCycle: (direction: -1 | 1) => void }) {
  const item = variants.find((entry) => entry.id === variant)!
  return <div className="prototype-switcher"><button aria-label="上一个方案" onClick={() => onCycle(-1)}>←</button><span><small>可丢弃原型</small><b>{item.id} — {item.name}</b></span><button aria-label="下一个方案" onClick={() => onCycle(1)}>→</button></div>
}

function Metric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div> }
function SystemBadge() { return <StatusRow label="本地实例" detail="全部正常" /> }
function StatusRow({ label, detail }: { label: string; detail: string }) { return <div className="status-row"><i className="live-dot" /><span>{label}</span><small>{detail}</small></div> }
function HistoryRow({ symbol, title, time }: { symbol: string; title: string; time: string }) { return <div className="history-row"><strong>{symbol}</strong><span>{title}</span><small>{time}</small></div> }
function Evidence({ text, source }: { text: string; source: string }) { return <div className="evidence"><i>↗</i><span>{text}<small>{source}</small></span></div> }
function ReportBlock({ number, title, children }: { number: string; title: string; children: ReactNode }) { return <section className="report-block"><header><span>{number}</span><h3>{title}</h3></header><div>{children}</div></section> }
function MiniChart() { return <svg className="mini-chart" viewBox="0 0 300 92" role="img" aria-label="模拟价格趋势图"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".25"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient></defs><path className="area" d="M0 79 C25 72 32 58 55 62 S88 80 112 54 S147 50 168 35 S201 46 222 28 S264 15 300 7 L300 92 L0 92Z"/><path className="line" d="M0 79 C25 72 32 58 55 62 S88 80 112 54 S147 50 168 35 S201 46 222 28 S264 15 300 7"/></svg> }
