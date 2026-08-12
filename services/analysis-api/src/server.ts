import { resolve } from 'node:path'

import { checkSchema, createPool, createPortfolioRepository } from '@vibe-invest/product-dao'

import { buildApp } from './app.js'
import { createFinancialDataClient } from './financial-data-client.js'
import { createPiModel } from './model.js'

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'
const databasePath = process.env.DATABASE_PATH ?? resolve('data/vibe-invest.db')
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
  baseUrl: process.env.MODEL_BASE_URL,
  apiKey: modelApiKey,
})

const app = buildApp({
  databasePath,
  productDatabase: {
    checkSchema: () => checkSchema(productPool),
    close: () => productPool.end(),
  },
  portfolioRepository: createPortfolioRepository(productPool),
  staticDir,
  financialDataHealth: () => financialData.health(),
  fetchFinancialContext: (symbol, signal) => financialData.context(symbol, signal),
  searchNews: (keyword, signal) => financialData.searchNews(keyword, signal),
  fetchTechnicalIndicators: (symbol, startDate, endDate, signal) => (
    financialData.technicalIndicators(symbol, startDate, endDate, signal)
  ),
  fetchMarketPrices: (symbols, signal) => financialData.quotes(symbols, signal),
  model,
  analysisConcurrency: Number(process.env.ANALYSIS_CONCURRENCY ?? 2),
  modelConfigured: Boolean(
    modelProvider && process.env.MODEL_NAME && process.env.MODEL_BASE_URL && modelApiKey
    && (modelApiProtocol === 'responses' || modelApiProtocol === 'chat-completions'),
  ),
})

await app.listen({ host, port })
