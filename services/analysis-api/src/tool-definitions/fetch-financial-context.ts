import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const fetchFinancialContextDefinition: RegisteredToolDefinition = {
  model: {
    name: 'fetch_financial_context',
    description: '读取指定美股的标准化、只读金融上下文',
    parameters: Type.Object({ symbol: Type.Optional(Type.String({ minLength: 1 })) }),
  },
  resultSchema: Type.Object({ facts: Type.Array(Type.Unknown()) }),
  allowedRoles: ['main'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', countsAsToolRound: true,
}
