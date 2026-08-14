import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const readFilingDocumentDefinition: RegisteredToolDefinition = {
  model: {
    name: 'read_filing_document',
    description: '按稳定 Filing ID 读取 SEC 或 IR 官方文档的受控分页摘要',
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
