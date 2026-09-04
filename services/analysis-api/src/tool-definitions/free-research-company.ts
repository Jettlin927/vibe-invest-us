import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const getCompanyDossierDefinition: RegisteredToolDefinition = {
  model: {
    name: 'get_company_dossier',
    description: '读取公司的标准化财务概览、正式财务事实、确定性估值、可比公司和 SEC 官方事件；各部分独立降级并明确数据缺口',
    parameters: Type.Object({ symbol: Type.String({ minLength: 1 }) }),
  },
  resultSchema: Type.Object({
    facts: Type.Array(Type.Unknown()), gaps: Type.Array(Type.Unknown()),
    sources: Type.Optional(Type.Array(Type.Unknown())),
    overview: Type.Optional(Type.Unknown()),
  }),
  allowedRoles: ['main'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
  surfaces: ['conversation'],
  handlerOwner: 'research_capability',
}

export const getMarketStructureDefinition: RegisteredToolDefinition = {
  model: {
    name: 'get_market_structure',
    description: '读取宿主确定性计算的多周期价格结构、指标、波动、回撤、量价关系和关键位，不要求模型自行处理 K 线',
    parameters: Type.Object({ symbol: Type.String({ minLength: 1 }) }),
  },
  resultSchema: Type.Object({ facts: Type.Array(Type.Unknown()) }),
  allowedRoles: ['main'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
  surfaces: ['conversation'],
  handlerOwner: 'research_capability',
}
