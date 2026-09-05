import { Type } from '@earendil-works/pi-ai'
import type { RegisteredToolDefinition } from './types.js'

const text = () => Type.String({ minLength: 1, maxLength: 200 })
const operationId = Type.String({ minLength: 1, maxLength: 150 })
const symbol = text()
const block = Type.Object({
  type: Type.Union(['positions', 'stances', 'watchlist', 'research'].map(value => Type.Literal(value))),
  title: Type.Optional(Type.String({ maxLength: 200 })),
  symbols: Type.Optional(Type.Array(symbol, { maxItems: 100 })),
}, { additionalProperties: false })
function define(name: string, description: string, parameters: ReturnType<typeof Type.Object>, write = false): RegisteredToolDefinition {
  return {
    model: { name, description, parameters }, resultSchema: Type.Object({}),
    allowedRoles: ['main'], allowedStages: ['research'], surfaces: ['conversation'],
    sideEffect: write ? 'writes_workspace' : 'read_only', externalNetwork: 'none', hostAccess: 'none',
    resultRetention: 'research_record', modelProjection: 'full_result',
    executionMode: write ? 'sequential' : 'parallel', countsAsToolRound: true,
    handlerFactory: ({ researchCapability }) => (params, signal, onStart) => researchCapability(name, params, signal, onStart),
  }
}
export const workbenchToolDefinitions = [
  define('search_research_library', '按关键词或标的检索本实例已有研究和对话；先查目录再读取原文，历史观点不是当前事实', Type.Object({
    query: Type.Optional(Type.String({ maxLength: 200 })), symbol: Type.Optional(symbol),
    offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  })),
  define('read_research_record', '读取研究或对话的报告与已封存消息；保留原文引用和时间，分页继续读取。基于旧研究补查时先调用此工具', Type.Object({
    id: text(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  })),
  define('get_workspace_context', '读取当前持仓、现金、自选、研究立场和已保存页面；仅根对话可用，不向外部数据源发送', Type.Object({})),
  define('save_research_stance', '保存用户要求记录的研究立场和待验证条件，建议与已确认决定分开；不修改持仓。operationId 为本次操作稳定标识，重试沿用', Type.Object({
    operationId, symbol, stance: Type.String({ minLength: 1, maxLength: 4000 }),
    status: Type.Union([Type.Literal('suggested'), Type.Literal('confirmed'), Type.Literal('pending')]),
    conditions: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20 }),
    sourceRecordId: Type.Optional(text()), sourceReportVersionId: Type.Optional(text()),
  }), true),
  define('set_watchlist_item', '按用户要求添加或移除自选关系，不删除研究或持仓', Type.Object({
    symbol, enabled: Type.Boolean(), note: Type.Optional(Type.String({ maxLength: 500 })),
  }), true),
  define('record_portfolio_trade', '仅记录用户明确表示已经发生的买卖，不能把计划、建议或假设当成交。必须有数量与实际成交价；operationId 重试沿用', Type.Object({
    operationId, symbol, side: Type.Union([Type.Literal('buy'), Type.Literal('sell')]),
    quantity: Type.Number({ exclusiveMinimum: 0 }), price: Type.Number({ exclusiveMinimum: 0 }),
  }), true),
  define('save_workbench_page', '按要求创建或修改个人页面，只能组合已有组件并绑定当前数据；修改前读取现有页面，operationId 重试沿用', Type.Object({
    operationId, id: Type.Optional(text()), title: Type.String({ minLength: 1, maxLength: 200 }),
    blocks: Type.Array(block, { minItems: 1, maxItems: 20 }),
  }), true),
  define('read_workbench_page', '读取个人页面配置和历史版本，修改前先读取', Type.Object({ id: text() })),
  define('restore_workbench_page', '按用户要求恢复页面历史布局，新增版本而不删除历史', Type.Object({ operationId, id: text(), revision: Type.Integer({ minimum: 1 }) }), true),
]
export const workbenchToolNames = new Set(workbenchToolDefinitions.map(({ model }) => model.name))
