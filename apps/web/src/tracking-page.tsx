import { useState } from 'react'

import type {
  TrackingEvent, TrackingRun, TrackingRunDetail, TrackingTarget, WatchlistItem,
} from '@vibe-invest/contracts'

export type TrackingOverview = {
  watchlist: WatchlistItem[]
  targets: TrackingTarget[]
  activeScan: TrackingRun | null
  latestScan: TrackingRunDetail | null
  events: TrackingEvent[]
}

export function TrackingPage({
  overview, available, lastScan, loading, scanning, onWatch, onUnwatch, onScan, onAnalyze,
}: {
  overview: TrackingOverview | null
  available?: boolean | null
  lastScan?: TrackingRunDetail | null
  loading: boolean
  scanning: boolean
  onWatch: (symbol: string, note: string) => Promise<boolean>
  onUnwatch: (symbol: string) => Promise<void>
  onScan: () => Promise<void>
  onAnalyze: (symbol: string) => Promise<void>
}) {
  const [saving, setSaving] = useState(false)
  const watchlist = overview?.watchlist ?? []
  const targets = overview?.targets ?? []
  const events = overview?.events ?? []
  const active = scanning || overview?.activeScan?.status === 'running'
  const supported = available ?? (overview !== null)
  const resolvedScan = newerScan(lastScan, overview?.latestScan)
  const scanFailed = resolvedScan?.status === 'failed'
  const scanRunning = active || resolvedScan?.status === 'running'
  const gapCount = resolvedScan?.observations.filter(({ status }) => status === 'data_gap').length ?? 0
  const gapValue = !supported || !resolvedScan || scanFailed || scanRunning ? '—' : String(gapCount)
  const gapDescription = !supported
    ? '追踪服务不可用，完整性未知'
    : !resolvedScan ? '尚未扫描，完整性未知'
      : scanRunning ? '扫描中，完整性未知'
      : scanFailed ? `扫描失败：${resolvedScan.error ?? '未取得可比较数据'}`
        : gapCount ? '缺数不等于没有变化' : '最近扫描能力完整'
  const gapObservations = resolvedScan?.observations.filter(({ status }) => status === 'data_gap') ?? []

  async function addWatch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    const form = event.currentTarget
    const data = new FormData(form)
    const symbol = String(data.get('symbol') ?? '').trim().toUpperCase()
    const note = String(data.get('note') ?? '').trim()
    if (!symbol) return
    setSaving(true)
    try {
      if (await onWatch(symbol, note)) form.reset()
    } finally { setSaving(false) }
  }

  return <div className="tracking-page" role="region" aria-label="股票追踪">
    <header className="tracking-header">
      <div><p className="micro">WATCHLIST TRACKING</p><h1>追踪真正发生的变化</h1><p>先用确定性规则筛出技术面、基本面与消息面的新变化，再决定是否交给 AI 深入研究。</p></div>
      <button className="tracking-scan" onClick={() => void onScan()} disabled={active || loading || !supported}>{active ? '扫描中…' : '立即扫描'}</button>
    </header>

    <section className="tracking-summary" aria-label="追踪概览">
      <div><span>追踪标的</span><strong>{targets.length}</strong><small>自选与持仓去重并集</small></div>
      <div><span>待看变化</span><strong>{events.length}</strong><small>只展示跨基线的新事件</small></div>
      <div className={gapCount || scanFailed ? 'warning' : ''}><span>数据缺口</span><strong>{gapValue}</strong><small>{gapDescription}</small></div>
      <div><span>最近扫描</span><strong>{scanStatus(resolvedScan, overview?.activeScan)}</strong><small>{resolvedScan?.completedAt ? formatTime(resolvedScan.completedAt) : active ? '正在取得最新事实' : '尚未扫描'}</small></div>
    </section>
    {(scanFailed || gapObservations.length > 0) && <section className="tracking-gaps" role="region" aria-label="数据缺口详情">
      <strong>{scanFailed ? '最近扫描失败' : '以下能力没有取得可比较数据'}</strong>
      {scanFailed && gapObservations.length === 0
        ? <p>{resolvedScan?.error ?? '未取得任何有效观测'}</p>
        : gapObservations.map((observation) => <article key={observation.id}>
            <span>{observation.symbol} · {capabilityLabel(observation.capability)}</span>
            <p>{gapReason(observation.payload)}</p>
          </article>)}
    </section>}

    <div className="tracking-grid">
      <section className="tracking-watchlist">
        <header><div><p className="micro">自选清单</p><h2>你主动关注的标的</h2></div><span>{watchlist.length} 只</span></header>
        <form onSubmit={(event) => void addWatch(event)}>
          <label>股票代码<input name="symbol" aria-label="新增自选股票代码" placeholder="NVDA" required /></label>
          <label>备注<input name="note" aria-label="自选备注" placeholder="为什么关注它？" /></label>
          <button type="submit" disabled={saving}>{saving ? '保存中…' : '加入自选'}</button>
        </form>
        <div className="tracking-targets">{loading ? <p>正在读取追踪清单…</p> : targets.length ? targets.map((target) => {
          const watched = watchlist.find(({ symbol }) => symbol === target.symbol)
          return <article key={target.symbol}>
            <div><strong>{target.symbol}</strong><p>{watched?.note || (target.sources.includes('position') ? '当前持仓自动纳入追踪' : '等待下一次变化')}</p></div>
            <div className="tracking-tags">{target.sources.map((source) => <span key={source}>{source === 'watchlist' ? '自选' : '持仓'}</span>)}</div>
            {watched && <button className="text-button" aria-label={`移除自选 ${target.symbol}`} onClick={() => void onUnwatch(target.symbol)}>移除自选</button>}
          </article>
        }) : <p className="tracking-empty">加入一只自选，或先在“我的持仓”记录实际持仓。</p>}</div>
      </section>

      <section className="tracking-feed" role="region" aria-label="追踪动态">
        <header><div><p className="micro">变化动态</p><h2>为什么值得看</h2></div><span>事实时间优先</span></header>
        {events.length ? events.map((event) => <article key={event.id} className={`tracking-event ${event.severity}`}>
          <div className="tracking-event-meta"><span>{capabilityLabel(event.capability)} · {severityLabel(event.severity)}</span><time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time></div>
          <div className="tracking-event-body"><strong>{event.symbol}</strong><div><h3>{eventTitle(event)}</h3><p>{eventSummary(event)}</p></div></div>
          <footer><div><small>规则：{event.kind} · 与上次成功基线比较</small><EventEvidence event={event} /></div><button aria-label={`深入分析 ${event.symbol}`} onClick={() => void onAnalyze(event.symbol)}>深入分析</button></footer>
        </article>) : <div className="tracking-empty-feed"><strong>还没有新的变化</strong><p>第一次扫描只建立基线；之后相同事实不会重复提醒。</p></div>}
      </section>
    </div>
  </div>
}

function scanStatus(lastScan: TrackingRunDetail | null | undefined, active: TrackingRun | null | undefined) {
  if (active?.status === 'running') return '进行中'
  if (!lastScan) return '未开始'
  return ({ completed: '已完成', partial: '部分完成', failed: '失败', running: '进行中' } as const)[lastScan.status]
}

function newerScan(
  local: TrackingRunDetail | null | undefined, persisted: TrackingRunDetail | null | undefined,
) {
  if (!local) return persisted ?? null
  if (!persisted) return local
  return persisted.startedAt > local.startedAt ? persisted : local
}

function capabilityLabel(capability: TrackingEvent['capability']) {
  return ({ technical: '技术面', fundamental: '基本面', news: '消息面' } as const)[capability]
}
function severityLabel(severity: TrackingEvent['severity']) {
  return ({ info: '信息', warning: '注意', critical: '重要' } as const)[severity]
}

function eventTitle(event: TrackingEvent) {
  const payload = event.payload
  if (['ma_cross', 'technical.ma_cross'].includes(event.kind)) return payload.direction === 'bullish' ? '均线结构转强' : '均线结构转弱'
  if (['rsi_zone', 'technical.rsi_zone'].includes(event.kind)) return `RSI 进入${zoneLabel(event.payload)}区间`
  if (['volume_spike', 'technical.volume_spike'].includes(event.kind)) return '成交量明显放大'
  if (['price_move', 'market.price_move'].includes(event.kind)) return '价格相对上次扫描显著变化'
  if (['financial_period', 'fundamental.new_period'].includes(event.kind)) return '出现新的财务报告期'
  if (['financial_quality_flag', 'fundamental.quality_flag'].includes(event.kind)) return '新增财务质量警示'
  if (['official_event', 'news.official_event'].includes(event.kind)) return '出现新的官方公司事件'
  if (['news_title', 'news.headline'].includes(event.kind)) return '出现新的标题级消息线索'
  return '检测到新的可验证变化'
}

function eventSummary(event: TrackingEvent) {
  const payload = event.payload
  if (['ma_cross', 'technical.ma_cross'].includes(event.kind)) {
    const previous = record(payload.previous), current = record(payload.current)
    return `MA5 ${number(previous.ma5 ?? payload.previousMa5)} → ${number(current.ma5 ?? payload.currentMa5)}；MA20 ${number(previous.ma20 ?? payload.previousMa20)} → ${number(current.ma20 ?? payload.currentMa20)}。`
  }
  if (['price_move', 'market.price_move'].includes(event.kind)) {
    return `价格 ${money(payload.previous ?? payload.previousPrice)} → ${money(payload.current ?? payload.currentPrice)}，相对上次成功扫描变化 ${percent(payload.change ?? payload.changePct)}。`
  }
  if (['financial_period', 'fundamental.new_period'].includes(event.kind)) return `最新财期更新为 ${String(payload.current ?? payload.currentPeriod ?? payload.latestPeriod ?? '未知')}。`
  if (['official_event', 'news.official_event', 'news_title', 'news.headline'].includes(event.kind)) {
    const fact = record(payload.fact), value = record(fact.value)
    return String(value.title ?? value.eventType ?? payload.title ?? payload.eventType ?? '打开深入分析核对来源与正文。')
  }
  return '打开深入分析查看当前值、前值、来源与失效条件。'
}

function number(value: unknown) { return typeof value === 'number' ? value.toFixed(2) : '—' }
function money(value: unknown) { return typeof value === 'number' ? `US$${value.toFixed(2)}` : '—' }
function percent(value: unknown) { return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—' }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function zoneLabel(payload: Record<string, unknown>) {
  const zone = String(record(payload.current).zone ?? payload.zone ?? '新')
  return ({ overbought: '超买', oversold: '超卖', neutral: '中性' } as Record<string, string>)[zone] ?? zone
}
function gapReason(payload: Record<string, unknown>) {
  const gaps = Array.isArray(payload.gaps) ? payload.gaps : []
  const reasons = gaps.flatMap((gap) => {
    const item = record(gap)
    return typeof item.reason === 'string'
      ? [`${String(item.source ?? 'source')}: ${item.reason}`] : []
  })
  return reasons.join('；') || 'source_unavailable'
}
function EventEvidence({ event }: { event: TrackingEvent }) {
  const direct = record(event.payload.evidence)
  const fact = record(event.payload.fact)
  const evidence = Object.keys(direct).length ? direct : fact
  const source = typeof evidence.source === 'string' ? evidence.source : null
  const fetchedAt = typeof evidence.fetchedAt === 'string' ? evidence.fetchedAt : null
  const reference = typeof evidence.sourceReference === 'string'
    && /^https?:\/\//.test(evidence.sourceReference) ? evidence.sourceReference : null
  if (!source && !fetchedAt && !reference) return null
  return <span className="tracking-evidence">
    {source ?? 'source'}{fetchedAt ? ` · 取得 ${formatTime(fetchedAt)}` : ''}
    {reference && <> · <a href={reference} target="_blank" rel="noreferrer">打开来源</a></>}
  </span>
}
function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}
