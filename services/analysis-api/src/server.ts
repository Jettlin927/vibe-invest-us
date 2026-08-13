import { resolve } from 'node:path'

import {
  checkSchema, createAgentEventRepository, createAnalysisRepository, createPool,
  createPortfolioRepository, createRuntimeSettingsRepository,
  createToolProjectionRepository,
} from '@vibe-invest/product-dao'

import { buildApp } from './app.js'
import { createFinancialDataClient } from './financial-data-client.js'
import { createPiModel } from './model.js'

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'
const productDatabaseUrl = process.env.DATABASE_URL
if (!productDatabaseUrl) throw new Error('DATABASE_URL is required')
const productPool = createPool(productDatabaseUrl)
const staticDir = process.env.WEB_STATIC_DIR ?? resolve('public')
const financialDataUrl = process.env.FINANCIAL_DATA_URL ?? 'http://127.0.0.1:8000'
const financialData = createFinancialDataClient(financialDataUrl)
const modelProvider = process.env.MODEL_PROVIDER
const modelApiKey = process.env.MODEL_API_KEY
const modelApiProtocol = process.env.MODEL_API_PROTOCOL
const model = createPiModel({
  provider: modelProvider,
  apiProtocol: modelApiProtocol === 'responses' || modelApiProtocol === 'chat-completions'
    ? modelApiProtocol
    : undefined,
  modelName: process.env.MODEL_NAME,
  contextWindow: process.env.MODEL_CONTEXT_WINDOW
    ? Number(process.env.MODEL_CONTEXT_WINDOW) : undefined,
  baseUrl: process.env.MODEL_BASE_URL,
  apiKey: modelApiKey,
})

const app = buildApp({
  productDatabase: {
    checkSchema: () => checkSchema(productPool),
    close: () => productPool.end(),
  },
  portfolioRepository: createPortfolioRepository(productPool),
  analysisRepository: createAnalysisRepository(productPool),
  agentEventRepository: createAgentEventRepository(productPool),
  runtimeSettingsRepository: createRuntimeSettingsRepository(productPool),
  toolProjectionRepository: createToolProjectionRepository(productPool),
  staticDir,
  financialDataHealth: () => financialData.health(),
  fetchFinancialContext: (symbol, signal) => financialData.context(symbol, signal),
  searchNews: (keyword, signal) => financialData.searchNews(keyword, signal),
  searchNewsCandidates: (query, signal) => financialData.searchNews(query, signal),
  searchWebEvidence: (query, signal) => financialData.searchWeb(query, signal),
  readNewsDocument: (candidate, signal) => financialData.readNewsDocument(candidate, signal),
  listCompanyEvents: (symbol, signal) => financialData.companyEvents(symbol, signal),
  listOfficialCompanyEvents: (symbol, signal) => financialData.officialCompanyEvents(symbol, signal),
  getFinancialOverview: (symbol, signal) => financialData.financialOverview(symbol, signal),
  getFinancialMetricSeries: (symbol, metric, cursor, signal) => (
    financialData.financialMetricSeries(symbol, metric, cursor, signal)
  ),
  getValuationEvidence: (symbol, signal) => financialData.valuationEvidence(symbol, signal),
  getTechnicalEvidence: (symbol, signal) => financialData.technicalEvidence(symbol, signal),
  getPriceWindow: (symbol, startDate, endDate, cursor, signal) => (
    financialData.priceWindow(symbol, startDate, endDate, cursor, signal)
  ),
  readFilingDocument: (symbol, filingId, cursor, signal) => (
    financialData.filingDocument(symbol, filingId, cursor, signal)
  ),
  fetchTechnicalIndicators: (symbol, startDate, endDate, signal) => (
    financialData.technicalIndicators(symbol, startDate, endDate, signal)
  ),
  fetchMarketPrices: (symbols, signal) => financialData.quotes(symbols, signal),
  model,
  modelConfigured: Boolean(
    modelProvider && process.env.MODEL_NAME && process.env.MODEL_BASE_URL && modelApiKey
    && (modelApiProtocol === 'responses' || modelApiProtocol === 'chat-completions'),
  ),
  migrationVerificationToken: process.env.MIGRATION_VERIFICATION_TOKEN,
})

await app.listen({ host, port })
