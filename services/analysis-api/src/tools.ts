import { toolRegistry } from './tool-registry.js'

export const analysisModelTools = toolRegistry.project({ role: 'main', stage: 'research' })
export const financialSpecialistTools = toolRegistry.project({ role: 'fundamental', stage: 'research' })
export const newsSpecialistTools = toolRegistry.project({ role: 'news', stage: 'research' })
  .filter(({ name }) => name !== 'search_web_evidence')
export const technicalSpecialistTools = toolRegistry.project({ role: 'technical', stage: 'research' })
export const finalizationModelTools = toolRegistry.project({ role: 'main', stage: 'finalization' })

// ---- 扁平模式（实验开关 agentModeFlat=1）：单 Agent 直接持有全部领域工具 ----

const submitAnalysisReport = toolRegistry.definition('submit_analysis_report')!.model
const submitParameters = submitAnalysisReport.parameters as { required?: string[] }

// 扁平变体：specialistStatuses / specialistReferences 不再必填
export const flatSubmitAnalysisReportTool = {
  ...submitAnalysisReport,
  description: '提交最终结构化综合分析报告（扁平模式：无专项引用）',
  parameters: {
    ...submitParameters,
    required: (submitParameters.required ?? [])
      .filter((key) => !['specialistStatuses', 'specialistReferences'].includes(key)),
  },
}

const SPECIALIST_LAUNCH_TOOLS = [
  'run_news_analysis', 'run_fundamental_analysis', 'run_technical_analysis',
]

function dedupeByName<T extends { name: string }>(tools: T[]): T[] {
  const seen = new Set<string>()
  return tools.filter((tool) => (seen.has(tool.name) ? false : (seen.add(tool.name), true)))
}

export const flatResearchTools = dedupeByName([
  ...analysisModelTools.filter(({ name }) => (
    !SPECIALIST_LAUNCH_TOOLS.includes(name) && name !== 'submit_analysis_report'
  )),
  ...newsSpecialistTools,
  ...financialSpecialistTools,
  ...technicalSpecialistTools,
  flatSubmitAnalysisReportTool,
].filter(({ name }) => name !== 'submit_specialist_report'))

export const flatFinalizationTools = [flatSubmitAnalysisReportTool]

export const webSearchEvidenceTool = toolRegistry.definition('search_web_evidence')!.model
