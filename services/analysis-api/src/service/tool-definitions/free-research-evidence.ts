import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const searchEvidenceDefinition: RegisteredToolDefinition = {
  model: {
    name: 'search_evidence',
    description: '统一搜索结构化新闻与公司事件；返回可继续读取的证据引用、来源状态和 Web Search 补充资格',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      symbol: Type.Optional(Type.String({ minLength: 1 })),
    }),
  },
  resultSchema: Type.Object({
    facts: Type.Array(Type.Unknown()),
    sources: Type.Optional(Type.Array(Type.Unknown())),
    gaps: Type.Optional(Type.Array(Type.Unknown())),
    eligibility: Type.Optional(Type.Unknown()),
  }),
  allowedRoles: ['main'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
  surfaces: ['conversation'],
  handlerFactory: ({ researchCapability }) => (params, signal, onStart) => (
    researchCapability('search_evidence', params, signal, onStart)
  ),
}

export const readEvidenceDefinition: RegisteredToolDefinition = {
  model: {
    name: 'read_evidence',
    description: '读取已取得的证据引用；官方 Filing 的 passages 是当前受控字节页的正文片段。只按 nextCursor 翻页，null 表示结束，不要把 endByte 当作下一页游标',
    parameters: Type.Object({
      evidenceId: Type.String({ minLength: 1 }),
      cursor: Type.Optional(Type.String({ minLength: 1 })),
    }),
  },
  resultSchema: Type.Object({
    facts: Type.Array(Type.Unknown()),
    sources: Type.Optional(Type.Array(Type.Unknown())),
    gaps: Type.Optional(Type.Array(Type.Unknown())),
    returnedCount: Type.Optional(Type.Number()),
    totalCount: Type.Optional(Type.Number()),
    nextCursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    truncated: Type.Optional(Type.Boolean()),
  }),
  allowedRoles: ['main'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
  surfaces: ['conversation'],
  handlerFactory: ({ researchCapability }) => (params, signal, onStart) => (
    researchCapability('read_evidence', params, signal, onStart)
  ),
}
