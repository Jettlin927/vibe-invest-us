import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

const runId = Type.String({ minLength: 1 })

export const spawnAgentDefinition: RegisteredToolDefinition = {
  model: {
    name: 'spawn_agent',
    description: '创建一个受控研究子 Agent；子 Agent 只接收明确的任务，不继承完整私人上下文',
    parameters: Type.Object({
      goal: Type.String({ minLength: 1, maxLength: 4000 }),
      join: Type.Optional(Type.Union([Type.Literal('wait'), Type.Literal('async')])),
      contextRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
    }),
  },
  resultSchema: Type.Object({ agentId: Type.String(), runId: Type.String(), status: Type.String() }),
  allowedRoles: ['main'], allowedStages: ['research'], sideEffect: 'creates_agent',
  externalNetwork: 'none', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'sequential', countsAsToolRound: true,
}

export const waitAgentDefinition: RegisteredToolDefinition = {
  model: {
    name: 'wait_agent', description: '等待子 Agent 进入终态并返回紧凑结果',
    parameters: Type.Object({ runId }),
  },
  resultSchema: Type.Object({ runId: Type.String(), status: Type.String(), summary: Type.Optional(Type.String()) }),
  allowedRoles: ['main'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'none', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'sequential', countsAsToolRound: true,
}

export const readAgentResultDefinition: RegisteredToolDefinition = {
  model: {
    name: 'read_agent_result', description: '读取子 Agent 的紧凑摘要、状态和 Artifact 引用',
    parameters: Type.Object({ runId }),
  },
  resultSchema: Type.Object({ runId: Type.String(), status: Type.String(), summary: Type.Optional(Type.String()) }),
  allowedRoles: ['main'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'none', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'sequential', countsAsToolRound: true,
}

export const stopAgentDefinition: RegisteredToolDefinition = {
  model: {
    name: 'stop_agent', description: '停止一个仍在运行的子 Agent',
    parameters: Type.Object({ runId }),
  },
  resultSchema: Type.Object({ runId: Type.String(), stopped: Type.Boolean() }),
  allowedRoles: ['main'], allowedStages: ['research'], sideEffect: 'read_only',
  externalNetwork: 'none', hostAccess: 'none', resultRetention: 'research_record',
  modelProjection: 'bounded_summary', executionMode: 'sequential', countsAsToolRound: true,
}
