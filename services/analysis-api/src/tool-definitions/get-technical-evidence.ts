import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

export const getTechnicalEvidenceDefinition: RegisteredToolDefinition = {
  model: {
    name: 'get_technical_evidence',
    description: '读取宿主计算的实际历史范围、多周期结构、指标、波动、回撤、量价、关键位与冲突',
    parameters: Type.Object({ symbol: Type.Optional(Type.String({ minLength: 1 })) }),
  },
  resultSchema: Type.Object({
    symbol: Type.String(), actualStart: Type.String(), actualEnd: Type.String(),
    totalBarCount: Type.Integer(), structures: Type.Record(Type.String(), Type.Object({
      status: Type.Union([Type.Literal('available'), Type.Literal('unavailable')]),
      barCount: Type.Integer(), reason: Type.Optional(Type.String()),
      returnPct: Type.Optional(Type.Number()), high: Type.Optional(Type.Number()),
      low: Type.Optional(Type.Number()),
    })),
    indicators: Type.Object({
      ma_5: Type.Number(), ma_20: Type.Number(),
      macd: Type.Object({ line: Type.Number(), signal: Type.Number(), histogram: Type.Number() }),
      rsi_14: Type.Number(), annualized_volatility: Type.Number(),
      max_drawdown: Type.Number(), volume_ratio_5_to_20: Type.Number(),
    }),
    volatility: Type.Object({ annualized: Type.Number() }),
    drawdown: Type.Object({ maximum: Type.Number() }),
    volumePrice: Type.Object({ volumeRatio5To20: Type.Number() }),
    keyLevels: Type.Object({ support: Type.Number(), resistance: Type.Number() }),
    conflicts: Type.Array(Type.String()),
    facts: Type.Array(Type.Unknown()),
  }),
  allowedRoles: ['technical'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'financial_data', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'parallel', countsAsToolRound: true,
}
