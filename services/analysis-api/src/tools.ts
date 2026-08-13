import { toolRegistry } from './tool-registry.js'

export const analysisModelTools = toolRegistry.project({ role: 'main', stage: 'research' })
export const financialSpecialistTools = toolRegistry.project({ role: 'fundamental', stage: 'research' })
export const newsSpecialistTools = toolRegistry.project({ role: 'news', stage: 'research' })
  .filter(({ name }) => name !== 'search_web_evidence')
export const technicalSpecialistTools = toolRegistry.project({ role: 'technical', stage: 'research' })
export const finalizationModelTools = toolRegistry.project({ role: 'main', stage: 'finalization' })
