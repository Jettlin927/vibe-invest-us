import assert from 'node:assert/strict'
import test from 'node:test'

import { buildApp } from '../src/app.js'
import { createTestProductDatabase } from './support/product-database.js'
import { createTestTrackingRepository } from './support/tracking-repository.js'

const healthyFinancialData = async () => ({
  service: 'financial-data' as const,
  status: 'ok' as const,
})

function successfulTrackingData(overrides: Record<string, unknown> = {}) {
  const technical = {
    symbol: 'NVDA', actualStart: '2026-01-01', actualEnd: '2026-08-29', totalBarCount: 160,
    structures: {}, indicators: { ma_5: 99, ma_20: 100, rsi_14: 50 },
    volatility: {}, drawdown: {}, volumePrice: { volumeRatio5To20: 1 },
    keyLevels: {}, conflicts: [], facts: [],
    sources: [{ source: 'test-history', status: 'ok' }],
  }
  return {
    fetchTrackingQuotes: async () => [{
      symbol: 'NVDA', price: 100, observedAt: '2026-08-30T20:00:00Z',
      source: 'test-quotes', degraded: false, sources: [],
    }],
    getTechnicalEvidence: async () => technical,
    getFinancialOverview: async () => ({
      overview: { symbol: 'NVDA', latestPeriod: '2026-Q2', qualityFlags: [] },
      facts: [], sources: [{ source: 'test-fundamentals', status: 'ok' }],
    }),
    listOfficialCompanyEvents: async () => ({
      facts: [], sources: [{ source: 'test-official', status: 'empty' }],
    }),
    listCompanyEvents: async () => ({
      facts: [], sources: [{ source: 'test-news', status: 'empty' }],
    }),
    ...overrides,
  }
}

async function waitForScan(app: ReturnType<typeof buildApp>, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/tracking/scans/${id}` })
    if (response.json().status !== 'running') return response
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`tracking_scan_did_not_complete:${id}`)
}

function fact(
  id: string, type: string, observedAt: string, value: Record<string, unknown>,
) {
  return {
    id, type, value, observedAt, fetchedAt: `${observedAt.slice(0, 10)}T21:00:00Z`,
    source: 'test-source', sourceReference: `https://example.com/${id}`,
  }
}

test('用户可以通过 Tracking API 维护自选标的', async () => {
  const app = buildApp({
    ...createTestProductDatabase(),
    trackingRepository: createTestTrackingRepository(),
    financialDataHealth: healthyFinancialData,
  })
  await app.ready()

  const added = await app.inject({
    method: 'PUT', url: '/api/tracking/watchlist/nvda',
    payload: { note: '等待财报', enabled: true },
  })
  assert.equal(added.statusCode, 200)
  assert.deepEqual(added.json(), {
    symbol: 'NVDA', note: '等待财报', enabled: true,
    createdAt: added.json().createdAt, updatedAt: added.json().updatedAt,
  })

  const tracking = await app.inject({ method: 'GET', url: '/api/tracking' })
  assert.equal(tracking.statusCode, 200)
  assert.deepEqual(tracking.json().watchlist, [added.json()])
  assert.deepEqual(tracking.json().targets, [{ symbol: 'NVDA', sources: ['watchlist'] }])

  const disabled = await app.inject({
    method: 'PUT', url: '/api/tracking/watchlist/NVDA', payload: { enabled: false },
  })
  assert.equal(disabled.statusCode, 200)
  assert.equal(disabled.json().enabled, false)
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/tracking' })).json().targets, [])

  const removed = await app.inject({ method: 'DELETE', url: '/api/tracking/watchlist/NVDA' })
  assert.equal(removed.statusCode, 204)
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/tracking' })).json().watchlist, [])

  await app.close()
})

test('立即扫描先返回 202，扫描自选与持仓并集且同一时刻只允许一个运行批次', async () => {
  let releaseTechnical!: () => void
  const technicalGate = new Promise<void>((resolve) => { releaseTechnical = resolve })
  const data = successfulTrackingData()
  const app = buildApp({
    ...createTestProductDatabase(),
    trackingRepository: createTestTrackingRepository(),
    financialDataHealth: healthyFinancialData,
    ...data,
    getTechnicalEvidence: async (...args: Parameters<typeof data.getTechnicalEvidence>) => {
      await technicalGate
      return data.getTechnicalEvidence(...args)
    },
  })
  await app.ready()
  await app.inject({
    method: 'PUT', url: '/api/positions/NVDA', payload: { quantity: 1, averageCost: 90 },
  })
  await app.inject({
    method: 'PUT', url: '/api/tracking/watchlist/NVDA', payload: { note: '核心观察' },
  })

  const created = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  assert.equal(created.statusCode, 202)
  assert.equal(created.json().status, 'running')
  assert.deepEqual(created.json().targets, [{ symbol: 'NVDA', sources: ['watchlist', 'position'] }])

  const duplicate = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  assert.equal(duplicate.statusCode, 409)
  assert.equal(duplicate.json().error, 'tracking_run_active')

  releaseTechnical()
  const completed = await waitForScan(app, created.json().id)
  assert.equal(completed.statusCode, 200)
  assert.equal(completed.json().status, 'completed')
  assert.equal(completed.json().observations.length, 3)
  assert.deepEqual(completed.json().events, [])

  await app.close()
})

test('Tracking 扫描完成前评估盈利保护并持久化一次性触发事件', async () => {
  const database = createTestProductDatabase()
  const data = successfulTrackingData({
    fetchTrackingQuotes: async () => [{
      symbol: 'NVDA', price: 216, observedAt: '2026-09-04T20:00:00Z',
      source: 'test-quotes', degraded: false, sources: [],
    }],
    getTechnicalEvidence: async () => ({
      symbol: 'NVDA', actualStart: '2026-01-01', actualEnd: '2026-09-04', totalBarCount: 160,
      structures: {}, indicators: { ma_5: 210, ma_20: 205, rsi_14: 60 },
      volatility: {}, drawdown: {}, volumePrice: { volumeRatio5To20: 1 },
      keyLevels: {}, conflicts: [], facts: [], sources: [{ source: 'test-history', status: 'ok' }],
    }),
  })
  const app = buildApp({
    ...database, trackingRepository: createTestTrackingRepository(),
    financialDataHealth: healthyFinancialData, ...data,
  })
  await app.ready()
  await app.inject({
    method: 'PUT', url: '/api/positions/NVDA',
    payload: { quantity: 5, averageCost: 180 },
  })
  await app.inject({
    method: 'PUT', url: '/api/positions/NVDA/profit-protection',
    payload: { anchorPrice: 180, invalidationPrice: 162, coreRatio: 0.6, maxPortfolioWeight: 1 },
  })

  const scan = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  await waitForScan(app, scan.json().id)
  const triggers = await app.inject({ method: 'GET', url: '/api/profit-protection' })

  assert.equal(triggers.statusCode, 200)
  assert.equal(triggers.json().triggers.length, 1)
  assert.equal(triggers.json().triggers[0].rule, 'first_take_profit')
  const acknowledged = await app.inject({
    method: 'POST',
    url: `/api/profit-protection/triggers/${triggers.json().triggers[0].id}/acknowledge`,
  })
  assert.equal(acknowledged.statusCode, 200)
  assert.equal(acknowledged.json().status, 'acknowledged')
  await app.close()
})

test('技术指标缺失时仍按可用报价生成价格型盈利保护提醒', async () => {
  const database = createTestProductDatabase()
  const app = buildApp({
    ...database,
    trackingRepository: createTestTrackingRepository(),
    financialDataHealth: healthyFinancialData,
    ...successfulTrackingData({
      fetchTrackingQuotes: async () => [{
        symbol: 'NVDA', price: 126, observedAt: '2026-09-04T20:00:00Z',
        source: 'test-quotes', degraded: false, sources: [],
      }],
      getTechnicalEvidence: async () => { throw new Error('technical_history_unavailable') },
    }),
  })
  await app.ready()
  await app.inject({
    method: 'PUT', url: '/api/positions/NVDA',
    payload: { quantity: 1, averageCost: 90 },
  })
  await app.inject({
    method: 'PUT', url: '/api/positions/NVDA/profit-protection',
    payload: { anchorPrice: 90, invalidationPrice: 72, coreRatio: 0.6, maxPortfolioWeight: 1 },
  })

  const scan = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  const completed = await waitForScan(app, scan.json().id)
  const protection = await app.inject({ method: 'GET', url: '/api/profit-protection' })

  assert.equal(completed.json().status, 'partial')
  assert.equal(protection.json().triggers.length, 1)
  assert.equal(protection.json().triggers[0].rule, 'first_take_profit')
  await app.close()
})

test('盈利保护写入失败时 Tracking Run 明确降级而不是报告成功', async () => {
  const database = createTestProductDatabase()
  const app = buildApp({
    ...database,
    profitProtectionRepository: {
      ...database.profitProtectionRepository,
      async recordEvaluation() { throw new Error('profit_protection_storage_failed') },
    },
    trackingRepository: createTestTrackingRepository(),
    financialDataHealth: healthyFinancialData,
    ...successfulTrackingData({
      fetchTrackingQuotes: async () => [{
        symbol: 'NVDA', price: 126, observedAt: '2026-09-04T20:00:00Z',
        source: 'test-quotes', degraded: false, sources: [],
      }],
    }),
  })
  await app.ready()
  await app.inject({
    method: 'PUT', url: '/api/positions/NVDA',
    payload: { quantity: 1, averageCost: 90 },
  })
  await app.inject({
    method: 'PUT', url: '/api/positions/NVDA/profit-protection',
    payload: { anchorPrice: 90, invalidationPrice: 72, coreRatio: 0.6, maxPortfolioWeight: 1 },
  })

  const scan = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  const completed = await waitForScan(app, scan.json().id)

  assert.equal(completed.json().status, 'partial')
  assert.equal(completed.json().error, 'profit_protection_evaluation_failed')
  await app.close()
})

test('实例配置扫描间隔后自动运行 Tracking 且关闭服务会停止调度', async () => {
  const database = createTestProductDatabase()
  await database.portfolioRepository.recordReconcile('NVDA', 1, 90)
  let quoteCalls = 0
  const data = successfulTrackingData({
    fetchTrackingQuotes: async (...args: Parameters<ReturnType<typeof successfulTrackingData>['fetchTrackingQuotes']>) => {
      quoteCalls += 1
      return successfulTrackingData().fetchTrackingQuotes(...args)
    },
  })
  const app = buildApp({
    ...database, trackingRepository: createTestTrackingRepository(),
    financialDataHealth: healthyFinancialData, ...data, trackingScanIntervalMs: 20,
  })
  await app.ready()

  for (let attempt = 0; attempt < 50 && quoteCalls === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(quoteCalls > 0)
  await app.close()
  const callsAtClose = quoteCalls
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal(quoteCalls, callsAtClose)
})

test('Tracking 拒绝无效的定时扫描间隔', () => {
  assert.throws(() => buildApp({
    ...createTestProductDatabase(),
    trackingRepository: createTestTrackingRepository(),
    financialDataHealth: healthyFinancialData,
    trackingScanIntervalMs: Number.NaN,
  }), /invalid_tracking_scan_interval/)
})

test('定时扫描在没有自选或持仓目标时保持安静', async () => {
  const app = buildApp({
    ...createTestProductDatabase(), trackingRepository: createTestTrackingRepository(),
    financialDataHealth: healthyFinancialData, ...successfulTrackingData(),
    trackingScanIntervalMs: 10,
  })
  await app.ready()
  try {
    await new Promise((resolve) => setTimeout(resolve, 30))
    const state = await app.inject({ method: 'GET', url: '/api/tracking' })
    assert.equal(state.json().latestScan, null)
  } finally {
    await app.close()
  }
})

test('定时扫描前置读取失败时通过后台错误边界报告', async () => {
  const repository = createTestTrackingRepository()
  let reported: unknown
  const app = buildApp({
    ...createTestProductDatabase(),
    trackingRepository: {
      ...repository,
      async listWatchlist() { throw new Error('tracking_schedule_read_failed') },
    },
    financialDataHealth: healthyFinancialData,
    trackingScanIntervalMs: 10,
    trackingBackgroundError: (error) => { reported = error },
  })
  await app.ready()
  try {
    for (let attempt = 0; attempt < 20 && !reported; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.match(String(reported), /tracking_schedule_read_failed/)
  } finally {
    await app.close()
  }
})

test('Tracking Run 最终写库失败时通过后台错误边界报告', async () => {
  const repository = createTestTrackingRepository()
  let reported: unknown
  const app = buildApp({
    ...createTestProductDatabase(),
    trackingRepository: {
      ...repository,
      async completeRun() { throw new Error('tracking_completion_failed') },
    },
    financialDataHealth: healthyFinancialData,
    ...successfulTrackingData(),
    trackingBackgroundError: (error) => { reported = error },
  })
  await app.ready()
  await app.inject({
    method: 'PUT', url: '/api/positions/NVDA', payload: { quantity: 1, averageCost: 90 },
  })

  const response = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  assert.equal(response.statusCode, 202)
  for (let attempt = 0; attempt < 20 && !reported; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.match(String(reported), /tracking_completion_failed/)
  await app.close()
})

test('基线之后只为确定性技术、基本面、官方事件和新标题变化生成事件', async () => {
  let version = 1
  const trackingRepository = createTestTrackingRepository()
  const app = buildApp({
    ...createTestProductDatabase(), trackingRepository,
    financialDataHealth: healthyFinancialData,
    fetchTrackingQuotes: async () => [{
      symbol: 'NVDA', price: version === 1 ? 100 : 106,
      observedAt: version === 1 ? '2026-08-29T20:00:00Z' : '2026-08-30T20:00:00Z',
      source: 'test-quotes', degraded: false, sources: [],
    }],
    getTechnicalEvidence: async () => ({
      symbol: 'NVDA', actualEnd: version === 1 ? '2026-08-29' : '2026-08-30',
      facts: [],
      indicators: version === 1
        ? { ma_5: 99, ma_20: 100, rsi_14: 50 }
        : { ma_5: 101, ma_20: 100, rsi_14: 72 },
      volumePrice: { volumeRatio5To20: version === 1 ? 1 : 1.6 },
    }),
    getFinancialOverview: async () => ({
      overview: {
        symbol: 'NVDA', latestPeriod: version === 1 ? '2026-Q1' : '2026-Q2',
        qualityFlags: version === 1 ? [] : [{
          flag_type: 'margin_discontinuity', severity: 'warning', period: '2026-Q2',
        }],
      },
      facts: [fact(
        `financial-${version}`, 'reported_financial',
        version === 1 ? '2026-05-20' : '2026-08-28',
        { period: version === 1 ? '2026-Q1' : '2026-Q2' },
      )],
      sources: [{ source: 'test-fundamentals', status: 'ok' }],
    }),
    listOfficialCompanyEvents: async () => ({
      facts: [
        fact('filing-1', 'company_event', '2026-05-20', { filingId: '0001', form: '10-Q' }),
        ...(version === 1 ? [] : [
          fact('filing-2', 'company_event', '2026-08-30T12:00:00Z', { filingId: '0002', form: '8-K' }),
        ]),
      ],
      sources: [{ source: 'test-official', status: 'ok' }],
    }),
    listCompanyEvents: async () => ({
      facts: [
        fact('news-1', 'company_event', '2026-08-27T10:00:00Z', { title: 'Existing title' }),
        ...(version === 1 ? [] : [
          fact('news-2', 'company_event', '2026-08-30T10:00:00Z', { title: 'New product' }),
        ]),
      ],
      sources: [{ source: 'test-news', status: 'ok' }],
    }),
  })
  await app.ready()
  await app.inject({ method: 'PUT', url: '/api/tracking/watchlist/NVDA', payload: {} })

  const baseline = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  const baselineDetail = await waitForScan(app, baseline.json().id)
  assert.deepEqual(baselineDetail.json().events, [])

  version = 2
  const changed = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  const changedDetail = await waitForScan(app, changed.json().id)
  assert.equal(changedDetail.json().status, 'completed')
  assert.deepEqual(
    changedDetail.json().events.map(({ kind }: { kind: string }) => kind).sort(),
    [
      'financial_period', 'financial_quality_flag', 'ma_cross', 'news_title',
      'official_event', 'price_move', 'rsi_zone', 'volume_spike',
    ],
  )
  assert.ok(changedDetail.json().events.every(
    ({ baselineObservationId }: { baselineObservationId?: string }) => baselineObservationId,
  ))
  const eventsByKind = Object.fromEntries(changedDetail.json().events.map(
    (item: { kind: string; occurredAt: string }) => [item.kind, item],
  )) as Record<string, { occurredAt: string }>
  assert.equal(eventsByKind.price_move?.occurredAt, '2026-08-30T20:00:00Z')
  assert.equal(eventsByKind.ma_cross?.occurredAt, '2026-08-30')
  assert.equal(eventsByKind.financial_period?.occurredAt, '2026-08-28')
  assert.equal(eventsByKind.official_event?.occurredAt, '2026-08-30T12:00:00Z')

  const unchanged = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  assert.deepEqual((await waitForScan(app, unchanged.json().id)).json().events, [])

  await app.close()
})

test('Python 端点以来源失败返回 200 时扫描明确记录 data gap 而不是没有变化', async () => {
  const app = buildApp({
    ...createTestProductDatabase(), trackingRepository: createTestTrackingRepository(),
    financialDataHealth: healthyFinancialData,
    ...successfulTrackingData({
      getFinancialOverview: async () => ({
        overview: { symbol: 'NVDA', latestPeriod: null, qualityFlags: [] }, facts: [],
        sources: [{ source: 'sec', status: 'failed', error: 'timeout' }],
      }),
      listOfficialCompanyEvents: async () => ({
        facts: [], sources: [{ source: 'sec', status: 'failed', error: 'timeout' }],
      }),
      listCompanyEvents: async () => ({
        facts: [], sources: [{ source: 'google-news', status: 'failed', error: 'timeout' }],
      }),
    }),
  })
  await app.ready()
  await app.inject({ method: 'PUT', url: '/api/tracking/watchlist/NVDA', payload: {} })

  const created = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  const detail = (await waitForScan(app, created.json().id)).json()

  assert.equal(detail.status, 'partial')
  assert.deepEqual(
    detail.observations.map((item: { capability: string; status: string }) => ({
      capability: item.capability, status: item.status,
    })),
    [
      { capability: 'technical', status: 'success' },
      { capability: 'fundamental', status: 'data_gap' },
      { capability: 'news', status: 'data_gap' },
    ],
  )
  const overview = (await app.inject({ method: 'GET', url: '/api/tracking' })).json()
  assert.equal(overview.latestScan.id, detail.id)
  assert.equal(overview.latestScan.status, 'partial')
  assert.equal(
    overview.latestScan.observations.filter(
      ({ status }: { status: string }) => status === 'data_gap',
    ).length,
    2,
  )

  await app.close()
})

test('同一新闻标题跨来源重新出现时 eventKey 保持幂等', async () => {
  let step = 0
  const data = successfulTrackingData()
  const app = buildApp({
    ...createTestProductDatabase(), trackingRepository: createTestTrackingRepository(),
    financialDataHealth: healthyFinancialData, ...data,
    listCompanyEvents: async () => ({
      facts: step === 1 ? [fact(
        'provider-a-id', 'company_event', '2026-08-30T10:00:00Z', { title: 'New Product Launch' },
      )] : step === 3 ? [fact(
        'provider-b-id', 'company_event', '2026-08-30T12:00:00Z', { title: '  NEW   PRODUCT LAUNCH ' },
      )] : [],
      sources: [{ source: step === 3 ? 'provider-b' : 'provider-a', status: step === 2 ? 'empty' : 'ok' }],
    }),
  })
  await app.ready()
  await app.inject({ method: 'PUT', url: '/api/tracking/watchlist/NVDA', payload: {} })

  for (step = 0; step <= 3; step += 1) {
    const created = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
    await waitForScan(app, created.json().id)
  }
  const overview = (await app.inject({ method: 'GET', url: '/api/tracking' })).json()
  assert.equal(overview.events.filter(({ kind }: { kind: string }) => kind === 'news_title').length, 1)

  await app.close()
})

test('未配置来源返回空 sources 时扫描形成 data gap 而不是成功基线', async () => {
  const data = successfulTrackingData()
  const app = buildApp({
    ...createTestProductDatabase(), trackingRepository: createTestTrackingRepository(),
    financialDataHealth: healthyFinancialData,
    ...data,
    getTechnicalEvidence: async (...args: Parameters<typeof data.getTechnicalEvidence>) => ({
      ...(await data.getTechnicalEvidence(...args)),
      sources: [{ source: 'test-history', status: 'ok' }],
    }),
    getFinancialOverview: async () => ({
      overview: { symbol: 'NVDA', latestPeriod: null, qualityFlags: [] }, facts: [], sources: [],
    }),
    listOfficialCompanyEvents: async () => ({ facts: [], sources: [] }),
    listCompanyEvents: async () => ({ facts: [], sources: [] }),
  })
  await app.ready()
  await app.inject({ method: 'PUT', url: '/api/tracking/watchlist/NVDA', payload: {} })

  const created = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  const detail = (await waitForScan(app, created.json().id)).json()
  assert.equal(detail.status, 'partial')
  assert.deepEqual(detail.observations.map(
    ({ capability, status }: { capability: string; status: string }) => ({ capability, status }),
  ), [
    { capability: 'technical', status: 'success' },
    { capability: 'fundamental', status: 'data_gap' },
    { capability: 'news', status: 'data_gap' },
  ])

  await app.close()
})

test('Tracking 首页和扫描详情都只返回紧凑观测', async () => {
  const marker = `FULL_TRACKING_PAYLOAD:${'x'.repeat(200_000)}`
  const data = successfulTrackingData()
  let quoteVersion = 0
  const app = buildApp({
    ...createTestProductDatabase(), trackingRepository: createTestTrackingRepository(),
    financialDataHealth: healthyFinancialData,
    ...data,
    fetchTrackingQuotes: async () => [{
      symbol: 'NVDA', price: quoteVersion === 0 ? 100 : 106,
      observedAt: quoteVersion === 0 ? '2026-08-29T20:00:00Z' : '2026-08-30T20:00:00Z',
      source: 'test-quotes', degraded: false, sources: [],
    }],
    getTechnicalEvidence: async (...args: Parameters<typeof data.getTechnicalEvidence>) => ({
      ...(await data.getTechnicalEvidence(...args)), rawBars: marker,
    }),
    getFinancialOverview: async () => ({
      overview: { symbol: 'NVDA', latestPeriod: '2026-Q2', rawSecPayload: marker },
      facts: [fact('large-financial', 'reported_financial', '2026-08-28', { raw: marker })],
      sources: [{ source: 'sec', status: 'failed', error: 'timeout' }],
    }),
    listOfficialCompanyEvents: async () => ({
      facts: [], sources: [{ source: 'sec', status: 'ok' }],
    }),
    listCompanyEvents: async () => ({
      facts: [fact('large-news', 'company_event', '2026-08-30T10:00:00Z', {
        title: 'Large news payload', summary: marker,
      })],
      sources: [{ source: 'news', status: 'ok' }],
    }),
  })
  await app.ready()
  await app.inject({ method: 'PUT', url: '/api/tracking/watchlist/NVDA', payload: {} })
  const baseline = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  await waitForScan(app, baseline.json().id)

  quoteVersion = 1
  const created = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  const detail = await waitForScan(app, created.json().id)
  assert.doesNotMatch(detail.body, /FULL_TRACKING_PAYLOAD/)
  assert.equal(detail.json().events.some(({ kind }: { kind: string }) => kind === 'price_move'), true)

  const overview = await app.inject({ method: 'GET', url: '/api/tracking' })

  assert.doesNotMatch(overview.body, /FULL_TRACKING_PAYLOAD/)
  assert.ok(overview.body.length < 20_000, `overview bytes: ${overview.body.length}`)
  assert.deepEqual(
    overview.json().latestScan.observations.map((observation: {
      symbol: string; capability: string; status: string; payload: unknown
    }) => ({
      symbol: observation.symbol, capability: observation.capability,
      status: observation.status, payload: observation.payload,
    })).sort((left: { capability: string }, right: { capability: string }) => (
      left.capability.localeCompare(right.capability)
    )),
    [
      {
        symbol: 'NVDA', capability: 'fundamental', status: 'data_gap',
        payload: { gaps: [{ source: 'fundamental', reason: 'all_sources_failed' }] },
      },
      { symbol: 'NVDA', capability: 'news', status: 'success', payload: { gaps: [] } },
      { symbol: 'NVDA', capability: 'technical', status: 'success', payload: { gaps: [] } },
    ],
  )
  assert.equal(overview.json().events.some(({ kind }: { kind: string }) => kind === 'price_move'), true)
  assert.equal(overview.json().latestScan.events.length, 0)

  await app.close()
})

test('失败观测不覆盖上一次成功基线', async () => {
  let step = 1
  const data = successfulTrackingData()
  const app = buildApp({
    ...createTestProductDatabase(), trackingRepository: createTestTrackingRepository(),
    financialDataHealth: healthyFinancialData,
    ...data,
    fetchTrackingQuotes: async () => [{
      symbol: 'NVDA', price: step === 1 ? 100 : step === 2 ? 104 : 106,
      observedAt: `2026-08-${28 + step}T20:00:00Z`, source: 'test-quotes',
      degraded: false, sources: [],
    }],
    getTechnicalEvidence: async (...args: Parameters<typeof data.getTechnicalEvidence>) => {
      if (step === 2) throw new Error('technical_history_unavailable')
      return data.getTechnicalEvidence(...args)
    },
  })
  await app.ready()
  await app.inject({ method: 'PUT', url: '/api/tracking/watchlist/NVDA', payload: {} })

  const first = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  await waitForScan(app, first.json().id)

  step = 2
  const gap = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  const gapDetail = (await waitForScan(app, gap.json().id)).json()
  assert.equal(gapDetail.status, 'partial')
  assert.equal(
    gapDetail.observations.find(({ capability }: { capability: string }) => capability === 'technical').status,
    'data_gap',
  )

  step = 3
  const recovered = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  const recoveredDetail = (await waitForScan(app, recovered.json().id)).json()
  const priceEvent = recoveredDetail.events.find(({ kind }: { kind: string }) => kind === 'price_move')
  assert.ok(priceEvent)
  assert.equal(priceEvent.payload.previous, 100)
  assert.equal(priceEvent.payload.current, 106)

  await app.close()
})

test('多标的五类取数使用可配置的有界并发', async () => {
  let active = 0
  let maximumActive = 0
  let quoteCalls = 0
  let quotedSymbols: string[] = []
  const tracked = async <Value>(create: () => Value): Promise<Value> => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    try {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return create()
    } finally {
      active -= 1
    }
  }
  const app = buildApp({
    ...createTestProductDatabase(), trackingRepository: createTestTrackingRepository(),
    financialDataHealth: healthyFinancialData, trackingConcurrency: 2,
    fetchTrackingQuotes: async (symbols) => tracked(() => {
      quoteCalls += 1
      quotedSymbols = symbols
      return symbols.map((symbol) => ({
        symbol, price: 100, observedAt: '2026-08-30T20:00:00Z',
        source: 'test-quotes', degraded: false, sources: [],
      }))
    }),
    getTechnicalEvidence: async (symbol) => tracked(() => ({
      symbol, actualEnd: '2026-08-30', facts: [],
      indicators: { ma_5: 100, ma_20: 100, rsi_14: 50 },
      volumePrice: { volumeRatio5To20: 1 },
    })),
    getFinancialOverview: async (symbol) => tracked(() => ({
      overview: { symbol, latestPeriod: '2026-Q2', qualityFlags: [] }, facts: [],
      sources: [{ source: 'test-fundamentals', status: 'ok' }],
    })),
    listOfficialCompanyEvents: async () => tracked(() => ({
      facts: [], sources: [{ source: 'test-official', status: 'empty' }],
    })),
    listCompanyEvents: async () => tracked(() => ({
      facts: [], sources: [{ source: 'test-news', status: 'empty' }],
    })),
  })
  await app.ready()
  for (const symbol of ['NVDA', 'MU', 'AMD']) {
    await app.inject({
      method: 'PUT', url: `/api/positions/${symbol}`,
      payload: { quantity: 1, averageCost: 100 },
    })
  }

  const created = await app.inject({ method: 'POST', url: '/api/tracking/scans' })
  assert.equal((await waitForScan(app, created.json().id)).json().status, 'completed')
  assert.equal(maximumActive, 2)
  assert.equal(quoteCalls, 1)
  assert.deepEqual(quotedSymbols, ['AMD', 'MU', 'NVDA'])

  await app.close()
})

test('服务启动时收口遗留 running 批次并允许重新扫描', async () => {
  const trackingRepository = createTestTrackingRepository()
  await trackingRepository.beginRun({
    id: 'interrupted-run', targets: [{ symbol: 'NVDA', sources: ['watchlist'] }],
    startedAt: '2026-08-30T20:00:00Z',
  })
  const app = buildApp({
    ...createTestProductDatabase(), trackingRepository,
    financialDataHealth: healthyFinancialData, ...successfulTrackingData(),
  })

  await app.ready()

  const interrupted = await app.inject({
    method: 'GET', url: '/api/tracking/scans/interrupted-run',
  })
  assert.equal(interrupted.json().status, 'failed')
  assert.equal(interrupted.json().error, 'tracking_run_interrupted')
  assert.equal((await app.inject({ method: 'POST', url: '/api/tracking/scans' })).statusCode, 202)

  await app.close()
})
