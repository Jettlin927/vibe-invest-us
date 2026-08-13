import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const runTechnicalAnalysisDefinition: RegisteredToolDefinition = {
  model: {
    name: 'run_technical_analysis',
    description: '决定是否启动独立技术面 Agent，必须说明研究问题和理由',
    parameters: Type.Object({
      launch: Type.Boolean(), researchQuestion: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }),
  },
  resultSchema: Type.Object({
    launched: Type.Boolean(), status: Type.String(), reason: Type.Optional(Type.String()),
  }),
  allowedRoles: ['main'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
