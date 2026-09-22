import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const readFilingDocumentDefinition: RegisteredToolDefinition = {
  model: {
    name: 'read_filing_document',
    description: '按稳定 Filing ID 读取官方文档的受控字节页；passages 包含该页正文片段。只按 nextCursor 翻页，null 表示结束，不要用 endByte 翻页',
    parameters: Type.Object({
      symbol: Type.Optional(Type.String({ minLength: 1 })), filingId: Type.String({ minLength: 1 }),
      cursor: Type.Optional(Type.String({ minLength: 1 })),
    }),
  },
  resultSchema: Type.Object({
    facts: Type.Array(Type.Unknown()), items: Type.Array(Type.Unknown()),
    returnedCount: Type.Number(), totalCount: Type.Number(),
    nextCursor: Type.Union([Type.String(), Type.Null()]), truncated: Type.Boolean(),
  }),
  allowedRoles: ['fundamental'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
