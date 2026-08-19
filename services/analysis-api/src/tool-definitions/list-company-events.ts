import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const listCompanyEventsDefinition: RegisteredToolDefinition = {
  model: {
    name: 'list_company_events',
    description: '读取已标准化的公司事件证据',
    parameters: Type.Object({ symbol: Type.Optional(Type.String({ minLength: 1 })) }),
  },
  resultSchema: Type.Object({ facts: Type.Array(Type.Unknown()) }),
  allowedRoles: ['news', 'fundamental'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
