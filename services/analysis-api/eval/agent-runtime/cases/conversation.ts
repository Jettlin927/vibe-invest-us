import type { EvalCase } from '../types.js'
import { check, checkNoForbiddenTools, payloads } from '../harness/checks.js'
import { textTurn, toolTurn } from './shared.js'

async function startConversation(context: Parameters<EvalCase['run']>[0], message: string) {
  const response = await context.app.inject({
    method: 'POST', url: '/api/conversations', payload: { message },
  })
  if (response.statusCode === 202) {
    const body = response.json() as Record<string, unknown>
    const threadId = String(body.id)
    await context.waitForThreadTerminal(threadId)
    return { threadId }
  }
  throw new Error(`conversation_create_failed:${response.statusCode}:${response.body}`)
}

export const conversationDirectAnswerCase: EvalCase = {
  id: 'conversation-direct-answer',
  title: '自由对话：无标的闲聊直接回答且不投影研究工具',
  category: 'tools',
  description: '普通对话在没有 symbol 和意图时 Tool Projection 为空，不要求报告收口。',
  tags: ['conversation', 'projection', 'tool-minimalism'],
  modes: ['fixture', 'live'],
  target: 'conversation',
  modelOptions: { contextWindow: 64_000 },
  modelScript: () => [textTurn('可以。我会先解释概念，不会在没有数据时给出投资结论。')],
  run: (context) => startConversation(context, '用一句话说明你会怎么回答风险问题，不要生成报告。'),
  checks: [
    (observation) => {
      const events = payloads(observation)
      const chat = events.some((payload) => payload.type === 'chat_completed')
      const tools = events.filter((payload) => payload.type === 'tool_call')
      return check('direct_chat_completed', '对话直接结束且没有工具调用', chat && tools.length === 0,
        `chat=${chat};tools=${tools.length}`)
    },
    checkNoForbiddenTools,
    (observation) => check('no_report_artifact', '普通对话不生成研究报告版本', observation.reportVersions.length === 0,
      `reports=${observation.reportVersions.length}`),
  ],
}

export const conversationSymbolProjectionCase: EvalCase = {
  id: 'conversation-symbol-tool-projection',
  title: '自由对话：按当前消息投影最小领域工具',
  category: 'tools',
  description: 'K 线/均线意图只投影 get_market_structure；工具执行后允许直接回答。',
  tags: ['conversation', 'projection', 'research-tool'],
  modes: ['fixture', 'live'],
  target: 'conversation',
  fixtureOptions: { symbol: 'NVDA' },
  modelOptions: { contextWindow: 64_000 },
  modelScript: () => [
    toolTurn([{ name: 'get_market_structure', args: { symbol: 'NVDA' } }]),
    textTurn('NVDA 当前价格位于 20 日均线之上，但 20 日与 252 日结构存在冲突。'),
  ],
  run: (context) => startConversation(context, '看看 NVDA 的 K线、均线和 RSI。'),
  checks: [
    (observation) => {
      const events = payloads(observation)
      const projections = events.filter((payload) => payload.type === 'tool_projection')
      const projected = projections.flatMap((payload) => (
        Array.isArray(payload.visibleToolNames) ? payload.visibleToolNames as string[] : []
      ))
      return check('projection_matches_intent', '投影包含 get_market_structure 且不泄露底层领域工具',
        projected.includes('get_market_structure') && projected.includes('search_news_candidates') === false,
        `projected=${[...new Set(projected)].join(',')}`)
    },
    (observation) => check('research_tool_executed', '对话实际执行了研究工具', observation.stats.toolCalls > 0,
      `toolCalls=${observation.stats.toolCalls}`),
    checkNoForbiddenTools,
  ],
}
