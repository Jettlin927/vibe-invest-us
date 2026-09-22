import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../../src/app.js'
import type { ModelEvent } from '../../../src/service/agent-runtime/model.js'
import type { RuntimeSettings } from '@vibe-invest/contracts'
import { createTestProductDatabase } from '../../../test/support/product-database.js'
import type { FixtureWorld } from './fixture.js'

export type EvalModel = {
  analyze(input: unknown): AsyncIterable<ModelEvent>
  analyzeConversation?: (input: unknown) => AsyncIterable<ModelEvent>
  analyzeNews?: (input: unknown) => AsyncIterable<ModelEvent>
  analyzeFundamental?: (input: unknown) => AsyncIterable<ModelEvent>
  analyzeTechnical?: (input: unknown) => AsyncIterable<ModelEvent>
}

export async function createEvalRuntime(input: {
  model: EvalModel
  fixture: FixtureWorld
  settings?: Partial<RuntimeSettings>
  runtimeMinuteMs?: number
}) {
  const database = createTestProductDatabase()
  if (input.settings && Object.keys(input.settings).length > 0) {
    await database.runtimeSettingsRepository.save(input.settings, new Date().toISOString())
  }
  const current = await database.runtimeSettingsRepository.current()
  const app = buildApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: (symbol, signal) => input.fixture.fetchFinancialContext(symbol),
    searchNewsCandidates: (query, signal) => input.fixture.searchNewsCandidates(query),
    searchWebEvidence: (query, signal) => input.fixture.searchWebEvidence(query),
    readNewsDocument: (candidate, signal) => input.fixture.readNewsDocument(candidate as never),
    listCompanyEvents: (symbol, signal) => input.fixture.listCompanyEvents(symbol),
    listOfficialCompanyEvents: (symbol, signal) => input.fixture.listOfficialCompanyEvents(symbol),
    getFinancialOverview: (symbol, signal) => input.fixture.getFinancialOverview(symbol) as never,
    getFinancialMetricSeries: (symbol, metric, cursor, signal) => input.fixture.getFinancialMetricSeries(symbol, metric, cursor) as never,
    getValuationEvidence: (symbol, signal) => input.fixture.getValuationEvidence(symbol) as never,
    readFilingDocument: (symbol, filingId, cursor, signal) => input.fixture.readFilingDocument(symbol, filingId, cursor) as never,
    getTechnicalEvidence: (symbol, signal) => input.fixture.getTechnicalEvidence(symbol) as never,
    getPriceWindow: (symbol, startDate, endDate, cursor, signal) => input.fixture.getPriceWindow(symbol, startDate, endDate, cursor) as never,
    model: input.model,
    modelConfigured: true,
    runtimeMinuteMs: input.runtimeMinuteMs,
  })
  await app.ready()
  return {
    app: app as FastifyInstance,
    database,
    settings: current.values,
    async close() {
      await app.close()
    },
  }
}
