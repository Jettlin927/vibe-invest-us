import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const getFinancialMetricSeriesDefinition: RegisteredToolDefinition = {
  model: {
    name: 'get_financial_metric_series',
    description: '按标准化指标读取确定性期间序列；XBRL concept、unit、form、frame 和期间映射由宿主处理',
    parameters: Type.Object({
      symbol: Type.Optional(Type.String({ minLength: 1 })), metric: Type.String({ minLength: 1 }),
      cursor: Type.Optional(Type.String({ minLength: 1 })),
    }),
  },
  resultSchema: Type.Object({
    facts: Type.Array(Type.Unknown()), returnedCount: Type.Number(), totalCount: Type.Number(),
    nextCursor: Type.Union([Type.String(), Type.Null()]), truncated: Type.Boolean(),
  }),
  allowedRoles: ['fundamental'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
