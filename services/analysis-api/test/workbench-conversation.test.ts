import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  checkSchema, createAgentEventRepository, createAnalysisRepository, createConversationRepository,
  createPool, createPortfolioRepository, createRuntimeSettingsRepository, createToolProjectionRepository,
  createWorkbenchRepository, createResearchLibraryRepository, migrate,
} from '@vibe-invest/product-dao'
import { buildApp } from '../src/app.js'
import type { FreeConversationInput, ModelEvent, ConversationToolExecutor } from '../src/model.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL

test('真实 PostgreSQL 对话执行工作台工具：业务读写闭环、成交幂等、子任务与考虑买入边界', {
  skip: !databaseUrl || !migrationUrl, concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const prefix = randomUUID()
  const symbol = `W${prefix.replaceAll('-', '').slice(0, 7)}`.toUpperCase()
  const pool = createPool(databaseUrl!)
  const results = new Map<string, Awaited<ReturnType<ConversationToolExecutor>>>()
  const projected = new Map<string, string[]>()
  const ids: string[] = []
  let pageId = ''
  const fixtureCashEvents: string[] = []
  const trade = { symbol, side: 'buy', quantity: 2, price: 10, operationId: `${prefix}-trade` }
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool), analysisRepository: createAnalysisRepository(pool),
    conversationRepository: createConversationRepository(pool), agentEventRepository: createAgentEventRepository(pool),
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool), toolProjectionRepository: createToolProjectionRepository(pool),
    workbenchRepository: createWorkbenchRepository(pool), researchLibraryRepository: createResearchLibraryRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [] }),
    model: {
      async *analyze() {},
      async *analyzeConversation(input: FreeConversationInput): AsyncGenerator<ModelEvent> {
        const mode = input.userPrompt.startsWith('子任务探测') ? 'child' : input.userPrompt.includes('考虑买入') ? 'consider' : 'write'
        projected.set(mode, input.tools.map((tool) => tool.name))
        const call = async (key: string, name: string, params: Record<string, unknown>) => {
          const result = await input.executeTool(name, params, input.signal ?? new AbortController().signal, async () => {})
          results.set(key, result)
          return result
        }
        if (mode === 'child') {
          await call('child', 'get_workspace_context', {})
          await call('child-write', 'save_research_stance', { operationId: `${prefix}-child`, symbol, stance: '不能写入', status: 'confirmed', conditions: [] })
        } else if (mode === 'consider') {
          await call('consider', 'record_portfolio_trade', { ...trade, operationId: `${prefix}-consider` })
        } else {
          await call('workspace', 'get_workspace_context', {})
          await call('stance', 'save_research_stance', { operationId: `${prefix}-stance`, symbol, stance: '等待验证', status: 'pending', conditions: ['检查订单'], sourceThreadId: 'spoofed' })
          const saved = await call('page', 'save_workbench_page', { operationId: `${prefix}-page`, title: '对话生成的决策页', blocks: [{ type: 'stances', symbols: [symbol] }, { type: 'positions', symbols: [symbol] }] })
          if (!saved.isError) pageId = String((saved.result.page as { id: string }).id)
          await call('trade', 'record_portfolio_trade', trade)
          await call('trade-retry', 'record_portfolio_trade', trade)
          await call('delegate', 'delegate_research', { goal: '子任务探测：读取工作台持仓并保存立场' })
        }
        yield { type: 'chat_completed', text: '测试完成', operationId: `${input.executionId}:done` }
      },
    },
  })
  async function wait(id: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const detail = (await app.inject({ method: 'GET', url: `/api/conversations/${id}` })).json()
      if (detail.thread?.status === 'completed') return detail
      if (detail.thread?.status === 'failed') assert.fail(JSON.stringify(detail))
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.fail(`conversation did not complete: ${id}`)
  }
  const original = (await app.inject({ method: 'GET', url: '/api/portfolio/stored' })).json().cash
  try {
    const beforeEvents = new Set((await app.inject({ method: 'GET', url: '/api/portfolio/events' })).json().events.map((event: { id: string }) => event.id))
    await app.inject({ method: 'PUT', url: '/api/portfolio/cash', payload: { cash: original + 100 } })
    fixtureCashEvents.push(...(await app.inject({ method: 'GET', url: '/api/portfolio/events' })).json().events.filter((event: { id: string; kind: string }) => event.kind === 'cash_adjust' && !beforeEvents.has(event.id)).map((event: { id: string }) => event.id))
    const created = await app.inject({ method: 'POST', url: '/api/conversations', payload: { message: '读取工作台，保存立场，创建页面。我已买入股票，记录成交。派子 Agent 核查。' } })
    assert.equal(created.statusCode, 202, created.body)
    const id = created.json().id
    ids.push(id)
    await wait(id)
    const children = (await app.inject({ method: 'GET', url: `/api/conversations/${id}/children` })).json().threads
    assert.equal(children.length, 1, JSON.stringify(results.get('delegate')))
    ids.push(children[0].id)
    await wait(children[0].id)
    for (const name of ['workspace', 'stance', 'page', 'trade', 'trade-retry']) {
      assert.equal(results.get(name)?.isError, false, `${name}: ${JSON.stringify(results.get(name))}`)
    }
    assert.ok(projected.get('write')?.includes('save_workbench_page'))
    assert.deepEqual(results.get('trade-retry'), results.get('trade'))
    const stances = (await app.inject({ method: 'GET', url: '/api/workbench/stances' })).json().stances
    const stance = stances.find((item: { symbol: string }) => item.symbol === symbol)
    assert.equal(stance.sourceThreadId, id)
    assert.equal(stance.revision, 1)
    const page = (await app.inject({ method: 'GET', url: `/api/workbench/pages/${pageId}` })).json().page
    assert.equal(page.title, '对话生成的决策页')
    assert.equal(results.get('page')?.result.href, `/workbench/${pageId}`)
    const stored = (await app.inject({ method: 'GET', url: '/api/portfolio/stored' })).json()
    assert.equal(stored.cash, original + 80)
    assert.equal(stored.positions.find((item: { symbol: string }) => item.symbol === symbol).quantity, 2)
    const events = (await app.inject({ method: 'GET', url: '/api/portfolio/events' })).json().events
    assert.equal(events.filter((event: { symbol: string }) => event.symbol === symbol).length, 1)
    assert.equal(results.get('child')?.result.error, 'tool_not_available')
    assert.equal(results.get('child-write')?.result.error, 'tool_not_available')
    const considered = await app.inject({ method: 'POST', url: '/api/conversations', payload: { message: '考虑买入股票，要不要加仓？' } })
    assert.equal(considered.statusCode, 202, considered.body)
    ids.push(considered.json().id)
    await wait(considered.json().id)
    assert.ok(!projected.get('consider')?.includes('record_portfolio_trade'))
    assert.equal(results.get('consider')?.result.error, 'tool_not_available')
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/portfolio/stored' })).json(), stored)
  } finally {
    await app.close()
    const admin = createPool(migrationUrl!)
    try {
      await admin.query('DELETE FROM workbench_operations WHERE operation_id LIKE $1', [`${prefix}%`])
      await admin.query('DELETE FROM workbench_versions WHERE entity_id = ANY($1::text[])', [[symbol, pageId]])
      await admin.query('DELETE FROM portfolio_trade_operations WHERE operation_id LIKE $1', [`%${prefix}%`])
      await admin.query('DELETE FROM portfolio_events WHERE symbol=$1 OR id = ANY($2::text[])', [symbol, fixtureCashEvents])
      await admin.query('DELETE FROM positions WHERE symbol=$1', [symbol])
      await admin.query('UPDATE portfolio_settings SET cash=$1 WHERE id=1', [original])
      for (const id of ids.reverse()) await admin.query('DELETE FROM analyses WHERE id=$1', [id])
    } finally { await admin.end() }
  }
})

test('真实 PostgreSQL 对话只提供研究 ID：读取来源后授权对应标的继续取数并持久化来源', {
  skip: !databaseUrl || !migrationUrl, concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const sourceId = `source-${randomUUID().replaceAll('-', '')}`
  const factId = randomUUID()
  const admin = createPool(migrationUrl!)
  await admin.query(`INSERT INTO analyses(id,kind,symbol,status,active,note,created_at,updated_at)
    VALUES($1,'research','NVDA','completed',false,'已保存的季度研究',now(),now())`, [sourceId])
  await admin.query('INSERT INTO atomic_facts(id,payload_json,is_public) VALUES($1,$2,true)', [factId, JSON.stringify({
    id: factId, type: 'quote', value: 100, source: 'fixture', sourceReference: 'https://example.com/quote',
    observedAt: '2026-09-05', fetchedAt: '2026-09-05',
  })])
  await admin.query('INSERT INTO analysis_facts(analysis_id,fact_id) VALUES($1,$2)', [sourceId, factId])
  const pool = createPool(databaseUrl!)
  const results = new Map<string, Awaited<ReturnType<ConversationToolExecutor>>>()
  const fetched: string[] = []
  let threadId = ''
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool), analysisRepository: createAnalysisRepository(pool),
    conversationRepository: createConversationRepository(pool), agentEventRepository: createAgentEventRepository(pool),
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool), toolProjectionRepository: createToolProjectionRepository(pool),
    researchLibraryRepository: createResearchLibraryRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => { fetched.push(symbol); return { symbol, gaps: [], facts: [] } },
    model: {
      async *analyze() {},
      async *analyzeConversation(input: FreeConversationInput): AsyncGenerator<ModelEvent> {
        const call = async (key: string, name: string, params: Record<string, unknown>) => {
          results.set(key, await input.executeTool(name, params, input.signal ?? new AbortController().signal, async () => {}))
        }
        await call('source', 'read_research_record', { id: sourceId })
        await call('after', 'get_research_context', { symbol: 'NVDA' })
        await call('unrelated', 'get_research_context', { symbol: 'MSFT' })
        yield { type: 'chat_completed', text: '已读取原研究并继续取数', operationId: `${input.executionId}:done` }
      },
    },
  })
  try {
    const created = await app.inject({ method: 'POST', url: '/api/conversations', payload: {
      message: `基于研究记录 ${sourceId} 继续研究，请先读取来源，再补充资料。`,
    } })
    assert.equal(created.statusCode, 202, created.body)
    threadId = created.json().id
    let detail = created.json()
    for (let attempt = 0; attempt < 200; attempt += 1) {
      detail = (await app.inject({ method: 'GET', url: `/api/conversations/${threadId}` })).json()
      if (detail.thread?.status === 'completed' || detail.thread?.status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(detail.thread?.status, 'completed', JSON.stringify(detail))
    assert.equal(results.get('source')?.isError, false, JSON.stringify(results.get('source')))
    assert.ok((results.get('source')?.result.facts as Array<{ id: string }>).some((fact) => fact.id === factId))
    assert.equal(results.get('after')?.isError, false, JSON.stringify(results.get('after')))
    assert.equal(results.get('unrelated')?.result.error, 'tool_symbol_not_allowed')
    assert.deepEqual(fetched, ['NVDA'])
    assert.equal(detail.sources.length, 1)
    assert.equal(detail.sources[0].sourceRecordId, sourceId)
    assert.equal(detail.sources[0].available, true)
    assert.equal(detail.sources[0].href, `/research/${sourceId}`)
    const persisted = await createResearchLibraryRepository(pool).listSources(threadId)
    assert.equal(persisted[0]?.sourceRecordId, sourceId)
  } finally {
    await app.close()
    await admin.query('DELETE FROM analyses WHERE id = ANY($1::text[])', [[threadId, sourceId]])
    await admin.query('DELETE FROM atomic_facts WHERE id=$1', [factId])
    await admin.end()
  }
})
