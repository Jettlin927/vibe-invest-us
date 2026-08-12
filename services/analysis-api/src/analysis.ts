import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type { AnalysisReport, ModelEvent } from './model.js'
import type { FinancialContext, FinancialFact } from './financial-data-client.js'

type Fact = FinancialFact
type Model = { analyze(input: Record<string, unknown>): AsyncIterable<ModelEvent> }

export function createAnalysisService(options: {
  database: DatabaseSync
  model: Model
  fetchFinancialContext: (symbol: string, signal: AbortSignal) => Promise<FinancialContext>
  fetchMarketPrices?: (symbols: string[], signal: AbortSignal) => Promise<Record<string, number>>
  listPortfolioSymbols?: () => string[]
  getPortfolioContext?: (symbol: string, marketPrices: Record<string, number>) => unknown
  concurrency: number
}) {
  const { database } = options
  const controllers = new Map<string, AbortController>()
  const listeners = new Map<string, Set<(entry: Record<string, unknown>) => void>>()
  let running = 0
  database.prepare(`UPDATE analyses SET status = 'interrupted', updated_at = ? WHERE status IN ('queued', 'running')`)
    .run(new Date().toISOString())

  const traceCount = database.prepare('SELECT COUNT(*) AS count FROM analysis_trace WHERE analysis_id = ?')
  const insertTrace = database.prepare(
    'INSERT INTO analysis_trace (analysis_id, sequence, payload_json) VALUES (?, ?, ?)',
  )
  function persistFact(analysisId: string, fact: Fact) {
    database.prepare('INSERT OR IGNORE INTO atomic_facts (id, payload_json, is_public) VALUES (?, ?, 1)')
      .run(fact.id, JSON.stringify(fact))
    database.prepare('INSERT OR IGNORE INTO analysis_facts (analysis_id, fact_id) VALUES (?, ?)')
      .run(analysisId, fact.id)
  }
  function appendTrace(id: string, payload: unknown) {
    const row = traceCount.get(id) as { count: number }
    insertTrace.run(id, row.count + 1, JSON.stringify(payload))
    if (payload && typeof payload === 'object') {
      for (const listener of listeners.get(id) ?? []) listener(payload as Record<string, unknown>)
    }
  }
  function setStatus(id: string, status: string, extra: { report?: unknown; snapshot?: unknown; error?: string } = {}) {
    database.prepare(`UPDATE analyses SET status = ?, updated_at = ?, report_json = COALESCE(?, report_json), snapshot_json = COALESCE(?, snapshot_json), error = COALESCE(?, error) WHERE id = ?`)
      .run(status, new Date().toISOString(), extra.report ? JSON.stringify(extra.report) : null,
        extra.snapshot ? JSON.stringify(extra.snapshot) : null, extra.error ?? null, id)
    appendTrace(id, {
      type: 'status', status, at: new Date().toISOString(),
      ...(extra.error ? { error: extra.error } : {}),
    })
  }
  function get(id: string) {
    const row = database.prepare('SELECT * FROM analyses WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? mapAnalysis(row) : null
  }
  function create(symbolInput: string) {
    const symbol = symbolInput.trim().toUpperCase()
    const existing = database.prepare(`SELECT id FROM analyses WHERE symbol = ? AND status IN ('queued', 'running') ORDER BY created_at LIMIT 1`)
      .get(symbol) as { id: string } | undefined
    if (existing) return { analysisId: existing.id, existing: true }
    const id = randomUUID(), now = new Date().toISOString()
    database.prepare('INSERT INTO analyses (id, symbol, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, symbol, 'queued', now, now)
    appendTrace(id, { type: 'status', status: 'queued', at: now })
    queueMicrotask(schedule)
    return { analysisId: id, existing: false }
  }
  function schedule() {
    while (running < options.concurrency) {
      const next = database.prepare(`SELECT id FROM analyses WHERE status = 'queued' ORDER BY created_at LIMIT 1`)
        .get() as { id: string } | undefined
      if (!next) return
      running += 1
      void run(next.id).finally(() => { running -= 1; schedule() })
    }
  }
  async function run(id: string) {
    const job = get(id)
    if (!job) return
    const controller = new AbortController()
    controllers.set(id, controller)
    setStatus(id, 'running')
    try {
      const context = await options.fetchFinancialContext(job.symbol, controller.signal)
      const quoteFact = context.facts.find((fact) => fact.type === 'quote' && typeof fact.value === 'number')
      let portfolioPrices: Record<string, number> = {}
      let portfolioPriceGap = false
      if (options.fetchMarketPrices && options.listPortfolioSymbols) {
        try {
          portfolioPrices = await options.fetchMarketPrices(options.listPortfolioSymbols(), controller.signal)
        } catch (error) {
          if (controller.signal.aborted) throw error
          portfolioPriceGap = true
        }
      }
      if (quoteFact) portfolioPrices[job.symbol] = quoteFact.value as number
      const portfolioContext = options.getPortfolioContext?.(
        job.symbol,
        portfolioPrices,
      ) ?? { position: null, portfolio: null }
      const gaps = [
        ...(context.gaps ?? []),
        ...(portfolioPriceGap ? [{ capability: 'portfolio_prices', reason: 'source_unavailable' }] : []),
      ]
      const snapshot = { ...context, gaps, portfolioContext, createdAt: new Date().toISOString() }
      for (const fact of context.facts) persistFact(id, fact)
      database.prepare('UPDATE analyses SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(snapshot), id)
      appendTrace(id, {
        type: 'financial_context',
        gaps,
        degradedSources: sourceDegradations(context),
      })
      const modelContext = createModelContext(snapshot)
      for await (const event of options.model.analyze({
        symbol: job.symbol,
        systemPrompt: ANALYSIS_SYSTEM_PROMPT,
        userPrompt: `分析 ${job.symbol}。个人语境：${JSON.stringify(portfolioContext)}`,
        knownFacts: modelContext.facts,
        fetchFinancialContext: async () => modelContext, signal: controller.signal,
      })) {
        if (event.type === 'trace') {
          if (event.entry.type === 'tool_result') {
            const toolResult = event.entry.result as { facts?: Fact[] }
            for (const fact of toolResult.facts ?? []) persistFact(id, fact)
          }
          appendTrace(id, event.entry)
        }
        else if (event.type === 'text_delta') appendTrace(id, event)
        else if (event.type === 'cancelled') { setStatus(id, 'cancelled'); return }
        else if (event.type === 'completed') {
          appendTrace(id, {
            type: 'model_completed',
            usage: event.usage ?? null,
            stopReason: event.stopReason ?? null,
          })
          const hasPosition = Boolean((portfolioContext as { position?: unknown }).position)
          const personalized = hasPosition ? event.report : {
            ...event.report,
            personalImpact: null,
            conditionalSuggestion: null,
          }
          const report = enforceDataGaps(personalized, gaps)
          const status = report.limitations.length ? 'partial' : 'completed'
          setStatus(id, status, { report })
          return
        }
      }
    } catch (error) {
      if (controller.signal.aborted) setStatus(id, 'cancelled')
      else setStatus(id, 'failed', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      controllers.delete(id)
    }
  }
  function cancel(id: string) {
    const job = get(id)
    if (!job || !['queued', 'running'].includes(job.status)) return false
    controllers.get(id)?.abort()
    if (job.status === 'queued') setStatus(id, 'cancelled')
    return true
  }
  function research(id: string) {
    const analysis = get(id)
    if (!analysis) return null
    const facts = (database.prepare(`SELECT f.payload_json FROM atomic_facts f JOIN analysis_facts af ON af.fact_id = f.id WHERE af.analysis_id = ?`).all(id) as Array<{ payload_json: string }>)
      .map((row) => JSON.parse(row.payload_json))
    const trace = (database.prepare('SELECT payload_json FROM analysis_trace WHERE analysis_id = ? ORDER BY sequence').all(id) as Array<{ payload_json: string }>)
      .map((row) => JSON.parse(row.payload_json))
    return { ...analysis, facts, trace }
  }
  function listResearch(symbol?: string) {
    const rows = symbol
      ? database.prepare(`SELECT * FROM analyses WHERE symbol = ? AND status IN ('completed', 'partial', 'failed', 'cancelled', 'interrupted') ORDER BY created_at DESC`).all(symbol.toUpperCase())
      : database.prepare(`SELECT * FROM analyses WHERE status IN ('completed', 'partial', 'failed', 'cancelled', 'interrupted') ORDER BY created_at DESC`).all()
    return (rows as Record<string, unknown>[]).map(mapAnalysis)
  }
  function updateResearch(id: string, values: { starred?: boolean; note?: string }) {
    if (!get(id)) return null
    const current = get(id)!
    database.prepare('UPDATE analyses SET starred = ?, note = ?, updated_at = ? WHERE id = ?')
      .run(values.starred ?? current.starred ? 1 : 0, values.note ?? current.note, new Date().toISOString(), id)
    return get(id)
  }
  function removeResearch(id: string) {
    if (!get(id)) return false
    database.exec('BEGIN')
    try {
      database.prepare('DELETE FROM analyses WHERE id = ?').run(id)
      database.exec(`DELETE FROM atomic_facts WHERE id NOT IN (SELECT fact_id FROM analysis_facts)`)
      database.exec('COMMIT')
      return true
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
  function events(id: string) {
    const record = research(id)
    if (!record) return null
    return record.trace.map((entry: Record<string, unknown>) => {
      const event = entry.type === 'status' ? entry.status : entry.type
      return `event: ${event}\ndata: ${JSON.stringify(entry)}\n\n`
    }).join('')
  }
  async function *streamEvents(id: string, signal?: AbortSignal) {
    const record = research(id)
    if (!record) return
    const queue: Record<string, unknown>[] = []
    let wake: (() => void) | undefined
    const listener = (entry: Record<string, unknown>) => {
      queue.push(entry)
      wake?.()
    }
    const subscriptions = listeners.get(id) ?? new Set()
    subscriptions.add(listener)
    listeners.set(id, subscriptions)
    try {
      const current = research(id)
      if (!current) return
      for (const entry of current.trace) yield entry as Record<string, unknown>
      if (isTerminal(current.status)) return
      while (!signal?.aborted) {
        if (!queue.length) await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
        while (queue.length) {
          const entry = queue.shift()!
          yield entry
          if (entry.type === 'status' && isTerminal(String(entry.status))) return
        }
      }
    } finally {
      subscriptions.delete(listener)
      if (!subscriptions.size) listeners.delete(id)
    }
  }
  function close() { for (const controller of controllers.values()) controller.abort() }
  return { create, get, cancel, research, listResearch, updateResearch, removeResearch, events, streamEvents, close }
}

const ANALYSIS_SYSTEM_PROMPT = `你是个人美股研究助手，分析周期为未来一至四周。
先调用 fetch_financial_context 读取本次已冻结的金融上下文，再调用 submit_analysis_report 提交最终报告。
不得编造行情、新闻、财报、估值或持仓；所有事实判断只能引用工具结果中真实存在的事实 ID。
每条 keyJudgments 都必须关联一个或多个事实 ID；supportingEvidence 和 contraryEvidence 也必须引用事实 ID。
技术指标与估值结果由宿主程序计算，你只负责解释，不重新计算或改写输入数字。
数据不足时明确写入 limitations；缺行情不得判断走势，缺财报或估值输入不得给目标价，缺新闻不得推断新闻驱动。
操作建议只能是带前提的方向建议，不给具体股数或无条件买卖指令。`

function sourceDegradations(context: FinancialContext) {
  return Object.entries(context).flatMap(([capability, value]) => {
    if (!value || typeof value !== 'object' || !('degraded' in value) || !value.degraded) return []
    const sources = 'sources' in value && Array.isArray(value.sources) ? value.sources : []
    return [{ capability, sources }]
  })
}

function isTerminal(status: string) {
  return ['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(status)
}

function enforceDataGaps(report: AnalysisReport, gaps: unknown[]) {
  const capabilities = new Set(gaps.flatMap((gap) => (
    gap && typeof gap === 'object' && typeof (gap as { capability?: unknown }).capability === 'string'
      ? [(gap as { capability: string }).capability]
      : []
  )))
  const limitations = [...report.limitations]
  const add = (message: string) => { if (!limitations.includes(message)) limitations.push(message) }
  let result = { ...report, limitations }
  if (capabilities.has('quote') || capabilities.has('history')) {
    add('当前行情或历史行情缺失，无法生成走势判断')
    result = { ...result, marketState: '关键行情数据缺失', trend: '无法生成走势判断' }
  }
  if (capabilities.has('fundamentals') || capabilities.has('valuation')) {
    add('财报或估值输入缺失，未生成目标价')
    result = { ...result, valuation: null }
  }
  if (capabilities.has('news')) add('近期新闻不可用，无法判断新闻驱动')
  if (capabilities.has('portfolio_prices')) add('组合内部分持仓缺少当前价格，无法计算准确仓位占比和集中度')
  return result
}

function createModelContext(snapshot: FinancialContext & Record<string, unknown>) {
  const dailyBars = snapshot.facts.filter((fact) => fact.type === 'daily_bar')
  const news = snapshot.facts.filter((fact) => fact.type === 'news').slice(0, 8)
  const relevantFacts = snapshot.facts.filter((fact) => fact.type !== 'daily_bar' && fact.type !== 'news')
  const sampledHistory = [...dailyBars.slice(-10)]
  return {
    symbol: snapshot.symbol,
    facts: [...relevantFacts, ...news, ...sampledHistory],
    gaps: snapshot.gaps ?? [],
    indicators: snapshot.indicators,
    valuation: snapshot.valuation,
    portfolioContext: snapshot.portfolioContext,
    createdAt: snapshot.createdAt,
  }
}

function mapAnalysis(row: Record<string, unknown>) {
  return {
    id: row.id as string, symbol: row.symbol as string, status: row.status as string,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json as string) : null,
    report: row.report_json ? JSON.parse(row.report_json as string) : null,
    error: row.error as string | null,
    starred: Boolean(row.starred), note: row.note as string,
  }
}
