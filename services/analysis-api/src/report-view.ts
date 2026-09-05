import type { AnalysisReport } from './model.js'

export function legacyReport(report: Record<string, unknown>): AnalysisReport {
  return {
    title: asString(report.title), marketState: asString(report.marketState), trend: asString(report.trend),
    drivers: asStringArray(report.drivers), supportingEvidence: asStringArray(report.supportingEvidence),
    contraryEvidence: asStringArray(report.contraryEvidence),
    scenarios: Array.isArray(report.scenarios) ? report.scenarios.map((item) => {
      const scenario = asRecord(item)
      return { name: asString(scenario.name), condition: asString(scenario.condition), outcome: asString(scenario.outcome) }
    }) : [],
    invalidationConditions: asStringArray(report.invalidationConditions),
    valuation: asNullableString(report.valuation), personalImpact: asNullableString(report.personalImpact),
    conditionalSuggestion: asNullableString(report.conditionalSuggestion), limitations: asStringArray(report.limitations),
    keyJudgments: Array.isArray(report.keyJudgments) ? report.keyJudgments.map((item) => {
      const judgment = asRecord(item)
      return {
        judgment: asString(judgment.statement ?? judgment.judgment),
        evidence: asStringArray(judgment.supportingEvidence ?? judgment.evidence),
      }
    }) : [],
  }
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function asString(value: unknown) { return typeof value === 'string' ? value : '' }
function asStringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
function asNullableString(value: unknown) { return typeof value === 'string' ? value : null }
