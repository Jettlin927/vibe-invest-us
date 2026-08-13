import { toolRegistry } from './tool-registry.js'

export const analysisModelTools = toolRegistry.project({ role: 'main', stage: 'research' })
export const financialSpecialistTools = toolRegistry.project({ role: 'fundamental', stage: 'research' })
export const finalizationModelTools = toolRegistry.project({ role: 'main', stage: 'finalization' })
