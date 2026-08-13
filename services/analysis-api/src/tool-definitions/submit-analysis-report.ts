import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const submitAnalysisReportDefinition: RegisteredToolDefinition = {
  model: {
    name: 'submit_analysis_report',
    description: '提交最终结构化综合分析报告',
    parameters: Type.Object({
      kind: Type.Literal('integrated'),
      availability: Type.Union([
        Type.Literal('available'), Type.Literal('partial'), Type.Literal('unavailable'),
      ]),
      status: Type.Union([Type.Literal('completed'), Type.Literal('partial')]),
      gaps: Type.Array(Type.Object({
        capability: Type.String(), reason: Type.String(), impact: Type.String(),
      })),
      limitations: Type.Array(Type.String()),
      specialistStatuses: Type.Array(Type.Object({
        domain: Type.Union([
          Type.Literal('news'), Type.Literal('fundamental_valuation'), Type.Literal('technical'),
        ]),
        status: Type.Union([
          Type.Literal('not_started'), Type.Literal('completed'), Type.Literal('partial'),
          Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('budget_exhausted'),
        ]), impact: Type.String(),
      })),
      specialistReferences: Type.Array(Type.Object({
        domain: Type.Union([
          Type.Literal('news'), Type.Literal('fundamental_valuation'), Type.Literal('technical'),
        ]),
        sessionId: Type.String(), reportId: Type.String(), version: Type.Number(), status: Type.Union([
          Type.Literal('completed'), Type.Literal('partial'),
        ]),
      })),
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
      targetPrice: Type.Optional(Type.Object({
        method: Type.String(), inputs: Type.Array(Type.String()),
        range: Type.Object({ low: Type.Number(), high: Type.Number() }),
        asOf: Type.String(), evidence: Type.Array(Type.String()),
      })),
      keyJudgments: Type.Optional(Type.Array(Type.Object({
        type: Type.Union([
          Type.Literal('market'), Type.Literal('news'), Type.Literal('fundamental'),
          Type.Literal('technical'), Type.Literal('operational'),
        ]),
        statement: Type.String(),
        direction: Type.Union([
          Type.Literal('bullish'), Type.Literal('bearish'), Type.Literal('neutral'),
        ]),
        confidence: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
        supportingEvidence: Type.Array(Type.String()),
        contraryEvidence: Type.Array(Type.String()),
        contraryEvidenceStatus: Type.Union([
          Type.Literal('none_found'), Type.Literal('not_searched'), Type.Literal('not_applicable'),
        ]),
        invalidationConditions: Type.Array(Type.String()),
        affectedByMissingDomains: Type.Array(Type.Union([
          Type.Literal('news'), Type.Literal('fundamental_valuation'), Type.Literal('technical'),
        ])),
      }))),
    }),
  },
  resultSchema: Type.Object({ submitted: Type.Boolean() }),
  allowedRoles: ['main'], allowedStages: ['research', 'finalization'],
  sideEffect: 'creates_report', externalNetwork: 'none', resultRetention: 'report_version',
  modelProjection: 'acknowledgement', executionMode: 'sequential', countsAsToolRound: true,
}
