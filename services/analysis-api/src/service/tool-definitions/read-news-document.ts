import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const readNewsDocumentDefinition: RegisteredToolDefinition = {
  model: {
    name: 'read_news_document',
    description: '读取候选新闻的受限文档片段。factId 必须来自本次 search_news_candidates 或 search_web_evidence 返回的 facts[].id，其他 ID 会被拒绝',
    parameters: Type.Object({ factId: Type.String({ minLength: 1 }) }),
  },
  resultSchema: Type.Object({ facts: Type.Array(Type.Unknown()) }),
  allowedRoles: ['news'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
