import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const searchWebEvidenceDefinition: RegisteredToolDefinition = {
  model: {
    name: 'search_web_evidence',
    description: '仅在三个既定新闻源均不合格后搜索外部线索；结果仍须读取正文核实',
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }) }),
  },
  resultSchema: Type.Object({ facts: Type.Array(Type.Unknown()) }),
  allowedRoles: ['news'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
