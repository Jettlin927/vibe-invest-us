import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const getTechnicalIndicatorsDefinition: RegisteredToolDefinition = {
  model: {
    name: 'get_technical_indicators',
    description: '按股票编号和日期范围查询日线并计算确定性技术指标',
    parameters: Type.Object({
      symbol: Type.Optional(Type.String({ minLength: 1 })),
      startDate: Type.Optional(Type.String({ format: 'date' })),
      endDate: Type.Optional(Type.String({ format: 'date' })),
    }),
  },
  resultSchema: Type.Object({ facts: Type.Array(Type.Unknown()) }),
  allowedRoles: ['fundamental'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
