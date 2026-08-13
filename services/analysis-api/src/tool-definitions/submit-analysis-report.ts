import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const submitAnalysisReportDefinition: RegisteredToolDefinition = {
  model: {
    name: 'submit_analysis_report',
    description: '提交最终结构化综合分析报告',
    parameters: Type.Object({
      title: Type.Optional(Type.String()), marketState: Type.Optional(Type.String()),
      trend: Type.Optional(Type.String()), drivers: Type.Optional(Type.Array(Type.String())),
      supportingEvidence: Type.Optional(Type.Array(Type.String())),
      contraryEvidence: Type.Optional(Type.Array(Type.String())),
      scenarios: Type.Optional(Type.Array(Type.Object({
        name: Type.Optional(Type.String()), condition: Type.Optional(Type.String()),
        outcome: Type.Optional(Type.String()),
      }))),
      invalidationConditions: Type.Optional(Type.Array(Type.String())),
      valuation: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      personalImpact: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      conditionalSuggestion: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      limitations: Type.Optional(Type.Array(Type.String())),
      keyJudgments: Type.Optional(Type.Array(Type.Object({
        judgment: Type.Optional(Type.String()),
        evidence: Type.Optional(Type.Array(Type.String())),
      }))),
    }),
  },
  resultSchema: Type.Object({ submitted: Type.Boolean() }),
  allowedRoles: ['main'], allowedStages: ['research', 'finalization'],
  sideEffect: 'creates_report', externalNetwork: 'none', resultRetention: 'report_version',
  modelProjection: 'acknowledgement', countsAsToolRound: true,
}
