import type { Tool } from '@earendil-works/pi-ai'

export type ToolRole = 'main' | 'fundamental'
export type ToolStage = 'research' | 'finalization'

export type RegisteredToolDefinition = {
  model: Tool
  resultSchema: object
  allowedRoles: ToolRole[]
  allowedStages: ToolStage[]
  sideEffect: 'read_only' | 'creates_report'
  externalNetwork: 'none' | 'financial_data'
  resultRetention: 'research_record' | 'report_version'
  modelProjection: 'full_result' | 'bounded_summary' | 'acknowledgement'
  countsAsToolRound: boolean
}
