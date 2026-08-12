import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentEventRepository, AnalysisRepository } from '@vibe-invest/product-dao'

import type { AnalysisReport, ModelEvent } from './model.js'
import type { FactQueryResult, FinancialContext, FinancialFact } from './financial-data-client.js'

type Fact = FinancialFact
type Model = { analyze(input: Record<string, unknown> & { executionId: string }): AsyncIterable<ModelEvent> }

export function createAnalysisService(options: {
  repository: AnalysisRepository
  eventRepository: AgentEventRepository
  model: Model
  fetchFinancialContext: (symbol: string, signal: AbortSignal) => Promise<FinancialContext>
  searchNews?: (keyword: string, signal: AbortSignal) => Promise<FactQueryResult>
  fetchTechnicalIndicators?: (
    symbol: string, startDate: string, endDate: string, signal: AbortSignal,
  ) => Promise<FactQueryResult>
  fetchMarketPrices?: (symbols: string[], signal: AbortSignal) => Promise<Record<string, number>>
  listPortfolioSymbols?: () => Promise<string[]>
  getPortfolioContext?: (symbol: string, marketPrices: Record<string, number>) => Promise<unknown>
  concurrency: number
}) {
  const { repository } = options
  const controllers = new Map<string, AbortController>()
  const listeners = new Map<string, Set<(entry: AgentEvent) => void>>()
  const tasks = new Set<Promise<void>>()
  let running = 0
  const initialized = options.eventRepository.interruptActiveSessions(new Date().toISOString())

  async function appendEvent(
    sessionId: string,
    operationId: string,
    payload: Record<string, unknown>,
    projection?: {
      status?: string; report?: unknown; snapshot?: unknown; error?: string; facts?: Fact[]
    },
  ) {
    const result = await options.eventRepository.append({
      sessionId, operationId, event: payload, projection, createdAt: new Date().toISOString(),
    })
    if (result.created) for (const listener of listeners.get(sessionId) ?? []) listener(result.event)
    return result.event
  }
  async function appendTrace(sessionId: string, payload: unknown) {
    if (!payload || typeof payload !== 'object') return
    const entry = payload as Record<string, unknown>
    if (entry.type === 'model_event'
      && (entry.event as Record<string, unknown> | undefined)?.type === 'thinking_delta') return
    if (typeof entry.operationId !== 'string') throw new Error('agent_event_operation_id_required')
    const facts = entry.type === 'tool_result'
      ? ((entry.result as { facts?: Fact[] } | undefined)?.facts ?? [])
      : []
    await appendEvent(sessionId, entry.operationId, entry, facts.length ? { facts } : undefined)
  }
  async function setStatus(
    sessionId: string,
    operationId: string,
    status: string,
    extra: { report?: unknown; snapshot?: unknown; error?: string } = {},
  ) {
    await appendEvent(sessionId, operationId, {
      type: 'status', status, at: new Date().toISOString(),
      ...(extra.error ? { error: extra.error } : {}),
    }, { status, ...extra })
  }
  async function get(analysisId: string) {
    await initialized
    return repository.get(analysisId)
  }
  async function create(symbolInput: string) {
    await initialized
    const symbol = symbolInput.trim().toUpperCase()
    const analysisId = randomUUID(), now = new Date().toISOString()
    const sessionId = randomUUID()
    const executionId = randomUUID()
    const result = await options.eventRepository.createResearch({
      analysisId,
      sessionId,
      executionId,
      symbol,
      status: 'queued',
      operationId: `session:${sessionId}:created`,
      event: { type: 'status', status: 'queued', at: now },
      createdAt: now,
    })
    if (!result.created) return {
      analysisId: result.analysisId, sessionId: result.sessionId, existing: true,
    }
    queueMicrotask(() => void schedule())
    return { analysisId: result.analysisId, sessionId: result.sessionId, existing: false }
  }
  async function schedule() {
    while (running < options.concurrency) {
      running += 1
      const now = new Date().toISOString()
      let next: string | null
      try {
        next = await repository.claimNextQueued(now)
      } catch {
        running -= 1
        return
      }
      if (!next) { running -= 1; return }
      const session = await options.eventRepository.findPrimarySession(next)
      if (!session) { running -= 1; continue }
      const executionId = session.executionId
      try {
        await appendEvent(
          session.id,
          `execution:${executionId}:running`,
          { type: 'status', status: 'running', at: now },
          { status: 'running' },
        )
      } catch {
        try {
          await setStatus(
            session.id, `execution:${executionId}:running-failed`, 'interrupted',
            { error: 'analysis_running_trace_failed' },
          )
        } catch {
          // The claimed task must never proceed when its critical audit write failed.
        }
        running -= 1
        continue
      }
      const task = run(next, session.id, executionId).finally(() => { running -= 1; void schedule() })
      tasks.add(task)
      void task.then(() => tasks.delete(task), () => tasks.delete(task))
    }
  }
  async function run(analysisId: string, sessionId: string, executionId: string) {
    const job = await get(analysisId)
    if (!job) return
    const controller = new AbortController()
    controllers.set(analysisId, controller)
    const operationId = (kind: string) => `execution:${executionId}:${kind}`
    let modelEventSequence = 0
    const nextModelOperationId = (kind: string) => (
      `execution:${executionId}:model:${++modelEventSequence}:${kind}`
    )
    try {
      const context = await options.fetchFinancialContext(job.symbol, controller.signal)
      const quoteFact = context.facts.find((fact) => fact.type === 'quote' && typeof fact.value === 'number')
      let portfolioPrices: Record<string, number> = {}
      let portfolioPriceGap = false
      if (options.fetchMarketPrices && options.listPortfolioSymbols) {
        try {
          portfolioPrices = await options.fetchMarketPrices(await options.listPortfolioSymbols(), controller.signal)
        } catch (error) {
          if (controller.signal.aborted) throw error
          portfolioPriceGap = true
        }
      }
      if (quoteFact) portfolioPrices[job.symbol] = quoteFact.value as number
      const portfolioContext = await options.getPortfolioContext?.(
        job.symbol,
        portfolioPrices,
      ) ?? { position: null, portfolio: null }
      const gaps = [
        ...(context.gaps ?? []),
        ...(portfolioPriceGap ? [{ capability: 'portfolio_prices', reason: 'source_unavailable' }] : []),
      ]
      const snapshot = { ...context, gaps, portfolioContext, createdAt: new Date().toISOString() }
      await appendEvent(sessionId, operationId('financial-context'), {
        type: 'financial_context',
        gaps,
        capabilities: sourceDiagnostics(context),
        degradedSources: sourceDegradations(context),
      }, { snapshot, facts: context.facts })
      const modelContext = createModelContext(snapshot)
      for await (const event of options.model.analyze({
        executionId,
        symbol: job.symbol,
        systemPrompt: ANALYSIS_SYSTEM_PROMPT,
        userPrompt: `分析 ${job.symbol}。个人语境：${JSON.stringify(portfolioContext)}`,
        knownFacts: modelContext.facts,
        fetchFinancialContext: async () => modelContext, signal: controller.signal,
        searchNews: options.searchNews,
        fetchTechnicalIndicators: options.fetchTechnicalIndicators,
      })) {
        if (event.type === 'trace') {
          await appendTrace(sessionId, event.entry.operationId ? event.entry : {
            ...event.entry, operationId: nextModelOperationId(event.entry.type),
          })
        }
        else if (event.type === 'text_delta') await appendTrace(sessionId, event.operationId ? event : {
          ...event, operationId: nextModelOperationId('text-delta'),
        })
        else if (event.type === 'cancelled') {
          await setStatus(
            sessionId, event.operationId ?? nextModelOperationId('cancelled'), 'cancelled',
          ); return
        }
        else if (event.type === 'completed') {
          await appendTrace(sessionId, {
            operationId: event.operationId ?? nextModelOperationId('completed'),
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
          await setStatus(sessionId, operationId(`status-${status}`), status, { report })
          return
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        await setStatus(sessionId, operationId('status-cancelled'), 'cancelled')
      } else {
        await setStatus(sessionId, operationId('status-failed'), 'failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      controllers.delete(analysisId)
    }
  }
  async function cancel(analysisId: string) {
    const job = await get(analysisId)
    if (!job || !['queued', 'running'].includes(job.status)) return false
    controllers.get(analysisId)?.abort()
    if (job.status === 'queued') {
      const session = await options.eventRepository.findPrimarySession(analysisId)
      if (session) await setStatus(session.id, `session:${session.id}:queued-cancelled`, 'cancelled')
    }
    return true
  }
  async function research(analysisId: string) {
    await initialized
    const record = await repository.research(analysisId)
    if (!record) return null
    const session = await options.eventRepository.findPrimarySession(analysisId)
    const trace = session
      ? (await options.eventRepository.list(session.id, 0)).map(({ payload }) => payload)
      : []
    return { ...record, trace }
  }
  async function listResearch(symbol?: string) {
    await initialized
    return repository.listResearch(symbol)
  }
  async function updateResearch(analysisId: string, values: { starred?: boolean; note?: string }) {
    await initialized
    return repository.updateResearch(analysisId, values, new Date().toISOString())
  }
  async function removeResearch(analysisId: string) {
    await initialized
    return repository.removeResearch(analysisId)
  }
  async function *streamEvents(sessionId: string, afterSequence: number, signal?: AbortSignal) {
    await initialized
    const session = await options.eventRepository.getSession(sessionId)
    if (!session) return
    const queue: AgentEvent[] = []
    let wake: (() => void) | undefined
    const listener = (entry: AgentEvent) => {
      queue.push(entry)
      wake?.()
    }
    const subscriptions = listeners.get(sessionId) ?? new Set()
    subscriptions.add(listener)
    listeners.set(sessionId, subscriptions)
    try {
      let cursor = afterSequence
      const catchUp = await options.eventRepository.list(sessionId, afterSequence)
      for (const entry of catchUp) {
        cursor = entry.sequence
        yield entry
      }
      while (queue.length) {
        const entry = queue.shift()!
        if (entry.sequence <= cursor) continue
        cursor = entry.sequence
        yield entry
        if (entry.payload.type === 'status' && isTerminal(String(entry.payload.status))) return
      }
      const current = await options.eventRepository.getSession(sessionId)
      if (!current) return
      if (isTerminal(current.status)) {
        for (const entry of await options.eventRepository.list(sessionId, cursor)) {
          cursor = entry.sequence
          yield entry
        }
        return
      }
      while (!signal?.aborted) {
        if (!queue.some(({ sequence }) => sequence > cursor)) {
          await new Promise<void>((resolve) => {
            wake = resolve
            signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        wake = undefined
        while (queue.length) {
          const entry = queue.shift()!
          if (entry.sequence <= cursor) continue
          cursor = entry.sequence
          yield entry
          if (entry.payload.type === 'status' && isTerminal(String(entry.payload.status))) return
        }
      }
    } finally {
      subscriptions.delete(listener)
      if (!subscriptions.size) listeners.delete(sessionId)
    }
  }
  async function close() {
    for (const controller of controllers.values()) controller.abort()
    await Promise.allSettled(tasks)
  }
  return { create, get, cancel, research, listResearch, updateResearch, removeResearch, streamEvents, close }
}

const ANALYSIS_SYSTEM_PROMPT = `你是个人美股研究助手，分析周期为未来一至四周。
你可以自主规划分析路径。建议先确认本次冻结的金融上下文；按需调用 fetch_financial_context，遇到需要深入解释财报时可调用 analyze_financials。财报专家可通过受控工具补查关键词新闻和指定日期范围的技术指标。只能使用提供的只读工具，最终必须调用 submit_analysis_report 提交报告。
不得编造行情、新闻、财报、估值或持仓；所有事实判断只能引用工具结果中真实存在的事实 ID。
每条 keyJudgments 都必须关联一个或多个事实 ID；supportingEvidence 和 contraryEvidence 也必须引用事实 ID。
财报增长率、利润率、TTM、自由现金流、质量标记、技术指标与估值结果由宿主程序计算，你只负责解释，不重新计算或改写输入数字。
必须区分“当前估值倍数”和“目标价估值方法”：目标价方法不可用不等于当前 PE 等倍数不可用。
模型上下文中的日线是冻结快照的裁剪样本，不得据此声称数据源只有这些交易日；以 contextScope 中的数量说明裁剪范围。
数据不足时明确写入 limitations；缺行情不得判断走势，缺财报或估值输入不得给目标价，缺新闻不得推断新闻驱动。
操作建议只能是带前提的方向建议，不给具体股数或无条件买卖指令。`

function sourceDegradations(context: FinancialContext) {
  return Object.entries(context).flatMap(([capability, value]) => {
    if (!value || typeof value !== 'object' || !('degraded' in value) || !value.degraded) return []
    const sources = 'sources' in value && Array.isArray(value.sources) ? value.sources : []
    return [{ capability, sources }]
  })
}

function sourceDiagnostics(context: FinancialContext) {
  const capabilities = Object.entries(context).flatMap(([capability, value]) => {
    if (!value || typeof value !== 'object' || !('sources' in value) || !Array.isArray(value.sources)) return []
    const record = value as Record<string, unknown>
    const acceptedCount = Array.isArray(record.items)
      ? record.items.length
      : record.value === null || record.value === undefined ? 0 : 1
    return [{
      capability,
      adoptedSource: typeof record.adopted_source === 'string' ? record.adopted_source : null,
      acceptedCount,
      sources: value.sources,
    }]
  })
  const valuationSources = Array.isArray(context.valuation_sources) ? context.valuation_sources : []
  if (valuationSources.length) capabilities.push({
    capability: 'valuation', adoptedSource: context.valuation ? valuationSources[0]?.source ?? null : null,
    acceptedCount: context.valuation ? 1 : 0, sources: valuationSources,
  })
  return capabilities
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
  const financialSummary = createFinancialSummary(snapshot.fundamentals)
  const financialFactIds = collectFinancialFactIds(financialSummary, snapshot.facts)
  const relevantFacts = snapshot.facts.filter((fact) => (
    fact.type !== 'daily_bar'
    && fact.type !== 'news'
    && (!isFinancialFact(fact) || financialFactIds.has(fact.id))
  ))
  const sampledHistory = [...dailyBars.slice(-10)]
  return {
    symbol: snapshot.symbol,
    facts: [...relevantFacts, ...news, ...sampledHistory],
    gaps: snapshot.gaps ?? [],
    indicators: snapshot.indicators,
    financials: financialSummary,
    valuation: snapshot.valuation,
    portfolioContext: snapshot.portfolioContext,
    contextScope: {
      snapshotDailyBarCount: dailyBars.length,
      providedDailyBarCount: sampledHistory.length,
      note: '日线仅为冻结快照的上下文裁剪样本，不代表数据源总历史长度。',
    },
    createdAt: snapshot.createdAt,
  }
}

function createFinancialSummary(fundamentals: unknown) {
  if (!fundamentals || typeof fundamentals !== 'object') return null
  const value = (fundamentals as { value?: unknown }).value
  if (!value || typeof value !== 'object') return null
  const financials = value as Record<string, unknown>
  const quarters = Array.isArray(financials.quarters) ? financials.quarters : []
  const annuals = Array.isArray(financials.annuals) ? financials.annuals : []
  const latestPeriod = periodName(quarters[0])
  const priorYearPeriod = latestPeriod?.replace(/^(CY|FY)(\d{4})/, (_match, prefix, year) => `${prefix}${Number(year) - 1}`)
  const selectedQuarters = [quarters[0], quarters[1], quarters.find((period) => periodName(period) === priorYearPeriod)]
    .filter((period, index, selected) => period && selected.indexOf(period) === index)
  const derivedMetrics = Array.isArray(financials.derived_metrics)
    ? financials.derived_metrics.filter((metric) => {
        if (!metric || typeof metric !== 'object') return false
        const candidate = metric as Record<string, unknown>
        return candidate.scope === 'ttm' || candidate.period === latestPeriod
      })
    : []
  return {
    quarters: selectedQuarters,
    ttm: financials.ttm ?? null,
    annuals: annuals.slice(0, 3),
    derivedMetrics,
    qualityFlags: financials.quality_flags ?? [],
  }
}

function collectFinancialFactIds(summary: unknown, facts: FinancialFact[]) {
  const selected = new Set<string>()
  collectIds(summary, selected)
  const byId = new Map(facts.map((fact) => [fact.id, fact]))
  const queue = [...selected]
  while (queue.length) {
    const fact = byId.get(queue.shift()!)
    if (!fact || !fact.value || typeof fact.value !== 'object') continue
    const record = fact.value as Record<string, unknown>
    for (const input of [...asStrings(record.inputFactIds), ...asStrings(record.evidenceFactIds)]) {
      if (!selected.has(input)) { selected.add(input); queue.push(input) }
    }
  }
  return selected
}

function collectIds(value: unknown, ids: Set<string>) {
  if (Array.isArray(value)) { for (const item of value) collectIds(item, ids); return }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'fact_id' || key === 'factId') && typeof item === 'string') ids.add(item)
    else if ((key === 'input_fact_ids' || key === 'evidence_fact_ids') && Array.isArray(item)) {
      for (const id of item) if (typeof id === 'string') ids.add(id)
    } else collectIds(item, ids)
  }
}

function isFinancialFact(fact: FinancialFact) {
  return ['reported_financial', 'derived_financial_metric', 'financial_quality_flag'].includes(fact.type)
}

function periodName(value: unknown) {
  return value && typeof value === 'object' && typeof (value as { period?: unknown }).period === 'string'
    ? (value as { period: string }).period
    : null
}

function asStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
