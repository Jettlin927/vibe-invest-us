import assert from 'node:assert/strict'
import test from 'node:test'
import { toolRegistry } from '../src/tool-registry.js'

test('对话按意图开放历史读取与业务写入，普通研究不获得写工具', () => {
  const names = (message: string) => toolRegistry.projectConversation({ userMessage: message }).map(t => t.name)
  assert.ok(names('汇总以前研究和讨论中我的最新态度').includes('search_research_library'))
  assert.ok(names('读取研究记录 abc 的报告并继续补查').includes('read_research_record'))
  assert.ok(names('我已买入 AAPL 2 股，成交价 100，记录成交').includes('record_portfolio_trade'))
  assert.ok(!names('考虑买入 AAPL，要不要加仓？').includes('record_portfolio_trade'))
  assert.ok(names('创建持仓决策页面').includes('save_workbench_page'))
  assert.ok(!names('解释什么是页面').includes('save_workbench_page'))
})

test('持仓决策页和紧邻操作的补充信息延续工具，历史成交不授权新话题', () => {
  const names = (userMessage: string, scopeMessages: string[] = []) => toolRegistry.projectConversation({ userMessage, scopeMessages }).map(tool => tool.name)
  const page = '汇总所有持仓的最新态度、共识、分歧和待确认事项，并保存成一个会更新的持仓决策页'
  assert.ok(names(page).includes('save_workbench_page'))
  assert.ok(names('把第二个组件移到前面', [page]).includes('save_workbench_page'))
  assert.ok(names('把第二个组件移到前面', [page]).includes('read_workbench_page'))
  assert.ok(names('2 股，成交价100', ['我已买入 AAPL，帮我记录成交']).includes('record_portfolio_trade'))
  for (const [current, previous] of [
    ['2 股，成交价100', '考虑买入 AAPL'],
    ['2 股，成交价100', '我已买入 AAPL，但不要记录成交'],
    ['假设2股成交价100', '我已买入 AAPL，帮我记录成交'],
    ['2股成交价100，先不记录', '我已买入 AAPL，帮我记录成交'],
    ['今天市场怎么样', '我已买入 AAPL，帮我记录成交'],
  ]) assert.ok(!names(current!, [previous!]).includes('record_portfolio_trade'), current)
  assert.ok(!names('2 股，成交价100', ['今天市场怎么样', '我已买入 AAPL']).includes('record_portfolio_trade'))
  assert.ok(!names('不要把第二个组件移到前面', [page]).includes('save_workbench_page'))
  assert.ok(!names('把第二个组件移到前面').includes('save_workbench_page'))
})

test('组合请求按动作对象否定：禁止成交仍可保存立场或页面', () => {
  const names = (userMessage: string) => toolRegistry.projectConversation({ userMessage }).map(tool => tool.name)
  const message = '继续研究 AAPL，来源研究ID：fixture。读取讨论，不请求外部数据。然后保存研究立场：等待季度兑现，状态待确认，验证条件下一季。不要记录成交。'
  assert.ok(names(message).includes('save_research_stance'))
  assert.ok(!names(message).includes('record_portfolio_trade'))
  assert.ok(names('保存持仓决策页。不要记录成交。').includes('save_workbench_page'))
  assert.ok(!names('不要保存页面，只解释').includes('save_workbench_page'))
  assert.ok(!names('不要保存研究立场，只解释').includes('save_research_stance'))
  assert.ok(names('不要保存页面，只保存研究立场').includes('save_research_stance'))
})
