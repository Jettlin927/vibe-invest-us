import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

const readOnlyMetadata: Omit<RegisteredToolDefinition, 'model' | 'resultSchema'> = {
  allowedRoles: ['main'], allowedStages: ['research'],
  sideEffect: 'read_only', externalNetwork: 'financial_data',
  hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel',
  countsAsToolRound: true,
  surfaces: ['conversation'],
}

export const getMarketQuotesDefinition: RegisteredToolDefinition = {
  model: {
    name: 'get_market_quotes',
    description: '按需读取至多十个美股或 ETF 的最新可用报价，返回价格、上一交易日收盘价、行情观测时间、取得时间和来源。讨论大盘时可查询 SPY、QQQ；休市或延迟时按观测时间说明。',
    parameters: Type.Object({
      symbols: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 10 }),
    }),
  },
  resultSchema: Type.Object({
    facts: Type.Array(Type.Unknown()), quotes: Type.Array(Type.Unknown()),
    gaps: Type.Array(Type.Unknown()), fetchedAt: Type.String(),
  }),
  ...readOnlyMetadata,
  handlerFactory: ({ researchCapability }) => (params, signal, onStart) => (
    researchCapability('get_market_quotes', params, signal, onStart)
  ),
}

export const getResearchContextDefinition: RegisteredToolDefinition = {
  model: {
    name: 'get_research_context',
    description: '读取单个标的的紧凑研究起始资料，包括行情、历史、新闻、财务、指标、估值和明确数据缺口',
    parameters: Type.Object({ symbol: Type.String({ minLength: 1 }) }),
  },
  resultSchema: Type.Object({ facts: Type.Array(Type.Unknown()) }),
  ...readOnlyMetadata,
  handlerFactory: ({ researchCapability }) => (params, signal, onStart) => (
    researchCapability('get_research_context', params, signal, onStart)
  ),
}

export const compareSecuritiesDefinition: RegisteredToolDefinition = {
  model: {
    name: 'compare_securities',
    description: '按同一口径比较二至五个美股标的的财务质量、估值与市场结构；单个标的数据失败时保留其他结果并形成缺口',
    parameters: Type.Object({
      symbols: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 5 }),
    }),
  },
  resultSchema: Type.Object({
    facts: Type.Array(Type.Unknown()), comparisons: Type.Array(Type.Unknown()),
    gaps: Type.Array(Type.Unknown()),
  }),
  ...readOnlyMetadata,
  handlerFactory: ({ researchCapability }) => (params, signal, onStart) => (
    researchCapability('compare_securities', params, signal, onStart)
  ),
}

export const getPortfolioExposureDefinition: RegisteredToolDefinition = {
  model: {
    name: 'get_portfolio_exposure',
    description: '读取指定标的与当前个人组合的确定性关系；只返回该标的持仓和组合聚合指标，不披露其他持仓明细',
    parameters: Type.Object({ symbol: Type.String({ minLength: 1 }) }),
  },
  resultSchema: Type.Object({
    facts: Type.Array(Type.Unknown()),
    position: Type.Optional(Type.Unknown()), portfolio: Type.Unknown(), gaps: Type.Array(Type.Unknown()),
  }),
  ...readOnlyMetadata,
  handlerFactory: ({ researchCapability }) => (params, signal, onStart) => (
    researchCapability('get_portfolio_exposure', params, signal, onStart)
  ),
}
