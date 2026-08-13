import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const getValuationEvidenceDefinition: RegisteredToolDefinition = {
  model: {
    name: 'get_valuation_evidence',
    description: '读取宿主确定性计算的当前估值、授权可比公司、历史区间及方法可用状态',
    parameters: Type.Object({ symbol: Type.Optional(Type.String({ minLength: 1 })) }),
  },
  resultSchema: Type.Object({
    symbol: Type.String(), authorizedComparables: Type.Array(Type.String()),
    comparables: Type.Array(Type.Unknown()),
    currentMultiples: Type.Unknown(), historicalRanges: Type.Unknown(), methods: Type.Unknown(),
    facts: Type.Array(Type.Unknown()),
  }),
  allowedRoles: ['fundamental'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
