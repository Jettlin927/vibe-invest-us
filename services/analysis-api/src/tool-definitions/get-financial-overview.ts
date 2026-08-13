import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const getFinancialOverviewDefinition: RegisteredToolDefinition = {
  model: {
    name: 'get_financial_overview',
    description: '读取宿主已标准化的财务概览、报告期、质量标记和正式财务事实',
    parameters: Type.Object({ symbol: Type.Optional(Type.String({ minLength: 1 })) }),
  },
  resultSchema: Type.Object({ facts: Type.Array(Type.Unknown()), overview: Type.Unknown() }),
  allowedRoles: ['fundamental'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
