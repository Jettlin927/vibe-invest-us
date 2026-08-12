import { Type } from '@earendil-works/pi-ai'

const fetchFinancialContextTool = {
  name: 'fetch_financial_context',
  description: '读取指定美股的标准化、只读金融上下文',
  parameters: Type.Object({ symbol: Type.Optional(Type.String({ minLength: 1 })) }),
} as const

const analyzeFinancialsTool = {
  name: 'analyze_financials',
  description: '按需委托独立财报专家；专家可解释冻结财报，并通过受控工具补查新闻和技术指标',
  parameters: Type.Object({ symbol: Type.Optional(Type.String({ minLength: 1 })) }),
} as const

const submitAnalysisReportTool = {
  name: 'submit_analysis_report',
  description: '提交最终结构化综合分析报告',
  parameters: Type.Object({
    title: Type.Optional(Type.String()),
    marketState: Type.Optional(Type.String()),
    trend: Type.Optional(Type.String()),
    drivers: Type.Optional(Type.Array(Type.String())),
    supportingEvidence: Type.Optional(Type.Array(Type.String(), {
      description: '只填写工具结果中完整、原样的事实 ID，不要填写解释句子',
    })),
    contraryEvidence: Type.Optional(Type.Array(Type.String(), {
      description: '只填写工具结果中完整、原样的事实 ID，不要填写解释句子',
    })),
    scenarios: Type.Optional(Type.Array(Type.Object({
      name: Type.Optional(Type.String()),
      condition: Type.Optional(Type.String()),
      outcome: Type.Optional(Type.String()),
    }))),
    invalidationConditions: Type.Optional(Type.Array(Type.String())),
    valuation: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    personalImpact: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    conditionalSuggestion: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    limitations: Type.Optional(Type.Array(Type.String())),
    keyJudgments: Type.Optional(Type.Array(Type.Object({
      judgment: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.Array(Type.String(), {
        description: '只填写工具结果中完整、原样的事实 ID，不要填写解释句子',
      })),
    }))),
  }),
} as const

export const analysisModelTools = [
  fetchFinancialContextTool,
  analyzeFinancialsTool,
  submitAnalysisReportTool,
] as const

const searchNewsByKeywordTool = {
  name: 'search_news_by_keyword',
  description: '按关键词查询新闻源，返回带来源、发布时间和事实 ID 的新闻事实',
  parameters: Type.Object({
    keyword: Type.Optional(Type.String({ minLength: 1 })),
  }),
} as const

const getTechnicalIndicatorsTool = {
  name: 'get_technical_indicators',
  description: '按股票编号和日期范围查询日线并计算确定性技术指标',
  parameters: Type.Object({
    symbol: Type.Optional(Type.String({ minLength: 1 })),
    startDate: Type.Optional(Type.String({ format: 'date' })),
    endDate: Type.Optional(Type.String({ format: 'date' })),
  }),
} as const

export const financialSpecialistTools = [searchNewsByKeywordTool, getTechnicalIndicatorsTool] as const
