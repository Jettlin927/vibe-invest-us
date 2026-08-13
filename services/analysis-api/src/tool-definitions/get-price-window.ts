import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const getPriceWindowDefinition: RegisteredToolDefinition = {
  model: {
    name: 'get_price_window',
    description: '读取受控价格窗口；长区间由宿主自动周采样并分页，不提供模型自算指标',
    parameters: Type.Object({
      symbol: Type.Optional(Type.String({ minLength: 1 })), startDate: Type.String(),
      endDate: Type.String(), cursor: Type.Optional(Type.String()),
    }),
  },
  resultSchema: Type.Object({
    symbol: Type.String(), actualStart: Type.String(), actualEnd: Type.String(),
    totalBarCount: Type.Integer(), sampling: Type.Union([Type.Literal('daily'), Type.Literal('weekly')]),
    returnedCount: Type.Integer(), totalCount: Type.Integer(),
    nextCursor: Type.Union([Type.String(), Type.Null()]), truncated: Type.Boolean(),
    facts: Type.Array(Type.Unknown()),
  }),
  allowedRoles: ['technical'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
