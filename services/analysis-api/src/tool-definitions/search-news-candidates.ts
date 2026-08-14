import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const searchNewsCandidatesDefinition: RegisteredToolDefinition = {
  model: {
    name: 'search_news_candidates',
    description: '查询新闻候选，返回标题、摘要、时间、来源、URL、证据等级和事实 ID',
    parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),
  },
  resultSchema: Type.Object({ facts: Type.Array(Type.Unknown()) }),
  allowedRoles: ['news'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
