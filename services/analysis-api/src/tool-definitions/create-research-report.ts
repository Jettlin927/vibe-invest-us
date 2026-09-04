import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const createResearchReportDefinition: RegisteredToolDefinition = {
  model: {
    name: 'create_research_report',
    description: '把当前已取得的研究判断保存为一份可回放的研究报告 Artifact',
    parameters: Type.Record(Type.String(), Type.Unknown()),
  },
  resultSchema: Type.Object({ submitted: Type.Boolean(), reportVersion: Type.Optional(Type.Number()) }),
  allowedRoles: ['main'], allowedStages: ['research'], sideEffect: 'creates_report',
  externalNetwork: 'none', hostAccess: 'none', resultRetention: 'report_version',
  modelProjection: 'acknowledgement', executionMode: 'sequential', countsAsToolRound: true,
  surfaces: ['conversation'],
  handlerOwner: 'research_capability',
}
