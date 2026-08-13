import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const analyzeFinancialsDefinition: RegisteredToolDefinition = {
  model: {
    name: 'analyze_financials',
    description: '按需委托独立财报专家；专家可解释冻结财报，并通过受控工具补查新闻和技术指标',
    parameters: Type.Object({ symbol: Type.Optional(Type.String({ minLength: 1 })) }),
  },
  resultSchema: Type.Object({ facts: Type.Array(Type.Unknown()), analysis: Type.String() }),
  allowedRoles: ['main'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'sequential', countsAsToolRound: true,
}
