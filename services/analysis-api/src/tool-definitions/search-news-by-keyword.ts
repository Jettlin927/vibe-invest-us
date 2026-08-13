import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const searchNewsByKeywordDefinition: RegisteredToolDefinition = {
  model: {
    name: 'search_news_by_keyword',
    description: '按关键词查询新闻源，返回带来源、发布时间和事实 ID 的新闻事实',
    parameters: Type.Object({ keyword: Type.Optional(Type.String({ minLength: 1 })) }),
  },
  resultSchema: Type.Object({ facts: Type.Array(Type.Unknown()) }),
  allowedRoles: ['fundamental'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
