import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const readNewsDocumentDefinition: RegisteredToolDefinition = {
  model: {
    name: 'read_news_document',
    description: '读取候选新闻的受限文档片段，保留摘要、hash 和元数据',
    parameters: Type.Object({ factId: Type.String({ minLength: 1 }) }),
  },
  resultSchema: Type.Object({ facts: Type.Array(Type.Unknown()) }),
  allowedRoles: ['news'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
