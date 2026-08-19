import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

const optionalNumber = Type.Optional(Type.Number())
const methodView = Type.Object({
  status: Type.Union([Type.Literal('available'), Type.Literal('unavailable')]),
  reason: Type.Optional(Type.String()), multiple: optionalNumber, targetPrice: optionalNumber,
  range: Type.Optional(Type.Object({ low: Type.Number(), high: Type.Number() })),
  multiplePercentile: optionalNumber,
})

export const getValuationEvidenceDefinition: RegisteredToolDefinition = {
  model: {
    name: 'get_valuation_evidence',
    description: '读取宿主确定性计算的当前估值、授权可比公司、历史区间及方法可用状态',
    parameters: Type.Object({ symbol: Type.Optional(Type.String({ minLength: 1 })) }),
  },
  resultSchema: Type.Object({
    symbol: Type.String(), authorizedComparables: Type.Array(Type.String()),
    comparables: Type.Array(Type.Object({
      symbol: Type.String(), pe: optionalNumber, evToEbitda: optionalNumber,
      evToRevenue: optionalNumber,
    })),
    currentMultiples: Type.Record(Type.String(), Type.Number()),
    historicalRanges: Type.Record(Type.String(), Type.Array(Type.Number())),
    methods: Type.Record(Type.String(), methodView),
    facts: Type.Array(Type.Unknown()),
  }),
  allowedRoles: ['fundamental'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
