// 扁平 Agent 模式实验验收：在隔离测试栈（docker-test.yml）上验证扁平模式端到端行为，
// 并输出可与分层模式对比的 Token 用量汇总。
//
// 环境变量：
//   VERIFY_AGENT_MODE=flat|hierarchical  默认 flat；hierarchical 用于同一标的的对照组
//   VERIFY_SYMBOL=NVDA                   研究标的
//   VERIFY_FLAT_TOOL_ROUNDS=40           扁平模式轮次上限（仅 flat）
//   VIBE_INVEST_BASE_URL                 测试栈地址（默认 http://127.0.0.1:3100）
//   REAL_ANALYSIS_TIMEOUT_SECONDS=1200   单个研究的最长等待
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const baseUrl = process.env.VIBE_INVEST_BASE_URL
  ?? `http://127.0.0.1:${process.env.VIBE_INVEST_TEST_PORT ?? '3100'}`
const timeoutMs = Number(process.env.REAL_ANALYSIS_TIMEOUT_SECONDS ?? 1200) * 1000
const mode = process.env.VERIFY_AGENT_MODE ?? 'flat'
const verifySymbol = (process.env.VERIFY_SYMBOL ?? 'NVDA').trim().toUpperCase()
const flatToolRounds = Number(process.env.VERIFY_FLAT_TOOL_ROUNDS ?? 40)
const successStatuses = new Set(['completed', 'partial'])
const domainTools = [
  'search_news_candidates', 'search_web_evidence', 'read_news_document', 'list_company_events',
  'get_financial_overview', 'get_financial_metric_series', 'get_valuation_evidence',
  'read_filing_document', 'get_technical_evidence', 'get_price_window',
]
const launchTools = ['run_news_analysis', 'run_fundamental_analysis', 'run_technical_analysis']

assert.ok(['flat', 'hierarchical'].includes(mode), 'VERIFY_AGENT_MODE must be flat or hierarchical')

const composeArgs = ['compose', '-f', 'docker-test.yml']
const postgresContainer = execFileSync(
  'docker', [...composeArgs, 'ps', '-q', 'postgres'], { encoding: 'utf8' },
).trim()
assert.ok(postgresContainer, 'postgres container is required (docker-test.yml)')

function sql(query) {
  return execFileSync('docker', [
    'exec', postgresContainer, 'psql', '-U', 'vibe_invest_bootstrap', '-d', 'vibe_invest',
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', query,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
}
function sqlJson(query) {
  const value = sql(`SELECT coalesce(json_agg(row_to_json(result))::text, '[]') FROM (${query}) result`)
  return JSON.parse(value || '[]')
}
function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options)
  const text = await response.text()
  let body = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  return { response, body, text }
}
async function json(path, options = {}, expected = 200) {
  const result = await request(path, options)
  assert.equal(result.response.status, expected, `${path}: ${result.response.status}`)
  return result.body
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(label, read, accept, timeout = timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    const last = await read()
    if (accept(last)) return last
    await sleep(500)
  }
  throw new Error(`${label} timed out`)
}

async function waitForHealth() {
  return waitFor('analysis-api health', async () => {
    try { return await json('/api/health') } catch { return null }
  }, (health) => health?.status === 'ok')
}

async function configureMode() {
  const settings = mode === 'flat'
    ? { agentModeFlat: 1, flatAgentToolRounds: flatToolRounds }
    : { agentModeFlat: 0 }
  await json('/api/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  })
  const current = await json('/api/settings')
  assert.equal(current.current.values.agentModeFlat, mode === 'flat' ? 1 : 0)
  console.log(JSON.stringify({ phase: 'configure', mode, flatToolRounds: mode === 'flat' ? flatToolRounds : null }))
}

async function verifyResearch() {
  const startedAt = Date.now()
  const created = await json('/api/analyses', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol: verifySymbol }),
  }, 202)
  const terminal = await waitFor(`analysis ${created.analysisId}`,
    () => json(`/api/analyses/${created.analysisId}`), (current) => current?.terminal === true)
  assert.ok(successStatuses.has(terminal.status),
    `analysis ended as ${terminal.status}: ${terminal.error ?? ''}`)
  const wallClockSeconds = Math.round((Date.now() - startedAt) / 1000)

  const research = await json(`/api/research/${created.analysisId}`)
  assert.ok(research.report && Array.isArray(research.report.keyJudgments), 'report with keyJudgments required')
  assert.ok(Array.isArray(research.facts) && research.facts.length > 0, 'facts required')

  const toolCalls = research.trace.filter(({ type }) => type === 'tool_call').map(({ name }) => name)
  const toolResults = research.trace.filter(({ type }) => type === 'tool_result')
  const domainCalls = toolCalls.filter((name) => domainTools.includes(name))
  const launchCalls = toolCalls.filter((name) => launchTools.includes(name))

  const [sessions] = sqlJson(`SELECT
    count(*)::integer AS total,
    count(*) FILTER (WHERE domain IS NOT NULL)::integer AS specialists
    FROM agent_sessions WHERE analysis_id=${literal(created.analysisId)}`)
  const specialistReports = Number(sql(`SELECT count(*) FROM report_versions
    WHERE analysis_id=${literal(created.analysisId)} AND kind='specialist'`))
  const integratedReports = Number(sql(`SELECT count(*) FROM report_versions
    WHERE analysis_id=${literal(created.analysisId)} AND kind='integrated'`))
  const frozenMode = sql(`SELECT settings_json->>'agentModeFlat'
    FROM execution_settings_snapshots WHERE execution_id=${literal(created.executionId)}`)

  if (mode === 'flat') {
    assert.equal(frozenMode, '1', 'execution settings snapshot must freeze agentModeFlat=1')
    assert.equal(sessions.total, 1, 'flat mode must use exactly one agent session')
    assert.equal(sessions.specialists, 0, 'flat mode must not create specialist sessions')
    assert.equal(launchCalls.length, 0, 'flat mode must not call run_* tools')
    assert.ok(domainCalls.length > 0, 'flat mode must call at least one domain tool directly')
    assert.equal(specialistReports, 0, 'flat mode must not create specialist reports')
    assert.ok(integratedReports >= 1, 'integrated report version required')
  } else {
    assert.equal(frozenMode, '0', 'execution settings snapshot must freeze agentModeFlat=0')
    assert.equal(sessions.specialists, 3, 'hierarchical mode must create three specialist sessions')
    assert.ok(launchCalls.length > 0, 'hierarchical mode must call run_* tools')
  }

  const usage = sqlJson(`SELECT r.kind,
    count(*)::integer AS requests,
    coalesce(sum(r.input_tokens), 0)::integer AS input,
    coalesce(sum(r.cache_read_tokens), 0)::integer AS cache_read,
    coalesce(sum(r.cache_write_tokens), 0)::integer AS cache_write,
    coalesce(sum(r.output_tokens), 0)::integer AS output,
    coalesce(sum(r.total_tokens), 0)::integer AS total
    FROM model_requests r
    JOIN agent_executions e ON e.id = r.execution_id
    JOIN agent_sessions s ON s.id = e.session_id
    WHERE s.analysis_id=${literal(created.analysisId)}
    GROUP BY r.kind ORDER BY r.kind`)
  const totals = usage.reduce((acc, row) => ({
    requests: acc.requests + row.requests,
    input: acc.input + row.input, cacheRead: acc.cacheRead + row.cache_read,
    cacheWrite: acc.cacheWrite + row.cache_write, output: acc.output + row.output,
    total: acc.total + row.total,
  }), { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 })
  assert.ok(totals.requests > 0, 'model requests with token usage required')
  const compactions = Number(sql(`SELECT count(*) FROM agent_compactions
    WHERE session_id=${literal(created.sessionId)}`))

  console.log(JSON.stringify({
    phase: 'research', mode, symbol: verifySymbol, analysisId: created.analysisId,
    status: terminal.status, wallClockSeconds,
    sessions: sessions.total, specialistSessions: sessions.specialists,
    domainToolCalls: domainCalls.length, launchToolCalls: launchCalls.length,
    toolResults: toolResults.length, integratedReports, specialistReports, compactions,
    tokenUsage: { ...totals, byKind: usage },
  }))
  return created
}

async function verifyFollowUp(created) {
  const followUp = await json(`/api/analyses/${created.analysisId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messageId: `flat-mode-chat-1-${mode}`,
      message: '请用一句话概括当前报告最重要的失效条件。',
      updateReport: false, baseReportVersion: 1,
    }),
  }, 202)
  const terminal = await waitFor(`follow-up ${created.analysisId}`,
    () => json(`/api/analyses/${created.analysisId}`), (current) => current?.terminal === true)
  assert.ok(successStatuses.has(terminal.status), `follow-up ended as ${terminal.status}`)
  const chatEvents = Number(sql(`SELECT count(*) FROM agent_events
    WHERE session_id=${literal(created.sessionId)} AND payload_json->>'type'='chat_completed'
      AND operation_id LIKE ${literal('%' + followUp.executionId + '%')}`))
  assert.ok(chatEvents > 0, 'chat_completed event required')
  if (mode === 'flat') {
    const [sessions] = sqlJson(`SELECT count(*)::integer AS total FROM agent_sessions
      WHERE analysis_id=${literal(created.analysisId)}`)
    assert.equal(sessions.total, 1, 'flat follow-up must not create specialist sessions')
  }
  console.log(JSON.stringify({ phase: 'follow-up', mode, status: terminal.status }))
}

await waitForHealth()
await configureMode()
const created = await verifyResearch()
await verifyFollowUp(created)
console.log(JSON.stringify({ phase: 'complete', mode, symbol: verifySymbol, status: 'passed' }))
