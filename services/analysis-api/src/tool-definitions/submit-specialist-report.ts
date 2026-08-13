import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const submitSpecialistReportDefinition: RegisteredToolDefinition = {
  model: {
    name: 'submit_specialist_report',
    description: '提交经四层校验的消息面、基本面或技术面专项报告',
    parameters: Type.Object({
      kind: Type.Literal('specialist'), domain: Type.Union([
        Type.Literal('news'), Type.Literal('fundamental_valuation'), Type.Literal('technical'),
      ]),
      availability: Type.Union([
        Type.Literal('available'), Type.Literal('partial'), Type.Literal('unavailable'),
      ]),
      status: Type.Union([Type.Literal('completed'), Type.Literal('partial')]),
      gaps: Type.Array(Type.Object({
        capability: Type.String(), reason: Type.String(), impact: Type.String(),
      })),
      limitations: Type.Array(Type.String()),
      keyJudgments: Type.Array(Type.Object({
        type: Type.Union([
          Type.Literal('news'), Type.Literal('fundamental'), Type.Literal('technical'),
        ]), statement: Type.String(),
        direction: Type.Union([
          Type.Literal('bullish'), Type.Literal('bearish'), Type.Literal('neutral'),
        ]),
        confidence: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
        supportingEvidence: Type.Array(Type.String()), contraryEvidence: Type.Array(Type.String()),
        contraryEvidenceStatus: Type.Union([
          Type.Literal('none_found'), Type.Literal('not_searched'), Type.Literal('not_applicable'),
        ]),
        invalidationConditions: Type.Array(Type.String()),
      })),
      targetPrice: Type.Optional(Type.Object({
        method: Type.String(), inputs: Type.Array(Type.String()),
        range: Type.Object({ low: Type.Number(), high: Type.Number() }),
        asOf: Type.String(), evidence: Type.Array(Type.String()),
      })),
    }),
  },
  resultSchema: Type.Object({ submitted: Type.Boolean() }),
  allowedRoles: ['news', 'fundamental', 'technical'], allowedStages: ['research', 'finalization'], sideEffect: 'creates_report',
  externalNetwork: 'none', resultRetention: 'report_version',
  modelProjection: 'acknowledgement', executionMode: 'sequential', countsAsToolRound: true,
}
