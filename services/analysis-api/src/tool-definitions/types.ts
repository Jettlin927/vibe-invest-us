import type { Tool } from '@earendil-works/pi-ai'
import type { ToolHandlerOwner } from '../tool-handler-catalog.js'

export type ToolRole = 'main' | 'fundamental' | 'news' | 'technical'
export type ToolStage = 'research' | 'finalization'
export type ToolSurface = 'analysis' | 'conversation'

export type RegisteredToolDefinition = {
  model: Tool
  resultSchema: object
  allowedRoles: ToolRole[]
  allowedStages: ToolStage[]
  sideEffect: 'read_only' | 'creates_report' | 'creates_agent' | 'controls_agent'
  externalNetwork: 'none' | 'financial_data'
  hostAccess: 'none'
  resultRetention: 'research_record' | 'report_version'
  modelProjection: 'full_result' | 'bounded_summary' | 'acknowledgement'
  executionMode: 'sequential' | 'parallel'
  countsAsToolRound: boolean
  surfaces?: ToolSurface[]
  handlerOwner?: ToolHandlerOwner
}
