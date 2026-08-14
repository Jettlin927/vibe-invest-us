import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const baseUrl = process.env.VIBE_INVEST_BASE_URL
  ?? `http://127.0.0.1:${process.env.VIBE_INVEST_PORT ?? '3000'}`
const timeoutMs = Number(process.env.REAL_ANALYSIS_TIMEOUT_SECONDS ?? 1200) * 1000
const contextWindow = Number(process.env.MODEL_CONTEXT_WINDOW)
const successStatuses = new Set(['completed', 'partial'])

assert.ok(Number.isInteger(contextWindow) && contextWindow > 73_000, 'MODEL_CONTEXT_WINDOW must exceed 73000')

const postgresContainer = execFileSync(
  'docker', ['compose', 'ps', '-q', 'postgres'], { encoding: 'utf8' },
).trim()
const analysisContainer = execFileSync(
  'docker', ['compose', 'ps', '-q', 'analysis-api'], { encoding: 'utf8' },
).trim()
assert.ok(postgresContainer, 'postgres container is required')
assert.ok(analysisContainer, 'analysis-api container is required')

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

function inList(values) {
  return values.length > 0 ? values.map(literal).join(',') : literal('__none__')
}

const safeErrorCodes = new Set([
  'analysis_running_trace_failed', 'execution_runtime_timeout',
  'execution_settings_snapshot_missing', 'follow_up_active_timeout',
  'report_tool_required', 'research_active_closure_required',
])

function safeErrorCode(value) {
  if (!value) return null
  return typeof value === 'string' && safeErrorCodes.has(value)
    ? value : 'unstructured_error'
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

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitFor(label, read, accept, timeout = timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    const last = await read()
    if (accept(last)) return last
    await sleep(500)
  }
  throw new Error(`${label} timed out`)
}

async function analysis(id) {
  return json(`/api/analyses/${id}`)
}

async function waitForTerminal(id, allowed = successStatuses) {
  const value = await waitForAnyTerminal(id)
  assert.ok(allowed.has(value.status), `analysis ${id} ended as ${value.status}`)
  return value
}

async function waitForAnyTerminal(id) {
  return waitFor(`analysis ${id}`, () => analysis(id), (current) => (
    current?.terminal === true
  ))
}

async function waitForActive(id) {
  return waitFor(`analysis ${id} to start`, () => analysis(id), (current) => (
    current?.terminal !== true && ['running_model', 'running_tools', 'waiting_for_specialists'].includes(current?.status)
  ))
}

async function waitForHealth() {
  return waitFor('analysis-api health', async () => {
    try { return await json('/api/health') } catch { return null }
  }, (health) => health?.status === 'ok')
}

async function createAnalysis(symbol) {
  return json('/api/analyses', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol }),
  }, 202)
}

async function followUp(id, body) {
  return json(`/api/analyses/${id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, 202)
}

async function replay(sessionId, after = 0) {
  const headers = after > 0 ? { 'last-event-id': `${sessionId}:${after}` } : {}
  const result = await request(`/api/agent-sessions/${sessionId}/events`, { headers })
  assert.equal(result.response.status, 200, `/api/agent-sessions/${sessionId}/events: ${result.response.status}`)
  return result.text
}

function reportVersionCount(analysisId, kind = 'integrated') {
  return Number(sql(
    `SELECT count(*) FROM report_versions WHERE analysis_id=${literal(analysisId)} AND kind=${literal(kind)}`,
  ))
}

async function verifyInfrastructure() {
  const health = await waitForHealth()
  assert.equal(health.dependencies?.productDatabase?.engine, 'postgresql')
  assert.equal(health.dependencies?.productDatabase?.schemaVersion, 24)
  assert.equal(health.dependencies?.financialData?.status, 'ok')
  const [privileges] = sqlJson(`SELECT
    has_schema_privilege('vibe_invest_app', 'public', 'CREATE') AS schema_create,
    has_database_privilege('vibe_invest_app', 'vibe_invest', 'CREATE') AS database_create,
    has_database_privilege('vibe_invest_app', 'vibe_invest', 'TEMP') AS database_temp`)
  assert.deepEqual(privileges, {
    schema_create: false, database_create: false, database_temp: false,
  })
  console.log(JSON.stringify({ phase: 'infrastructure', schemaVersion: 24, leastPrivilege: true }))
}

async function verifyFirstResearch() {
  for (const attempt of [1, 2]) {
    const created = await createAnalysis('NVDA')
    const ssePromise = replay(created.sessionId)
    const terminal = await waitForAnyTerminal(created.analysisId)
    if (!successStatuses.has(terminal.status)) {
      await ssePromise
      console.log(JSON.stringify({
        phase: 'first-research-attempt', attempt, analysisId: created.analysisId,
        status: terminal.status, error: safeErrorCode(terminal.error),
      }))
      continue
    }
    try {
      const research = await json(`/api/research/${created.analysisId}`)
      const sse = await ssePromise
      assert.ok(research.report && Array.isArray(research.report.keyJudgments))
      assert.ok(Array.isArray(research.facts) && research.facts.length > 0)
      assert.ok(Array.isArray(research.trace) && research.trace.some(({ type }) => type === 'tool_call'))
      assert.ok(research.trace.some(({ type }) => type === 'tool_result'))
      assert.equal(research.specialistAgents.length, 3)
      assert.ok(research.specialistAgents.every(({ reportVersion }) => reportVersion?.kind === 'specialist'))
      const launchCalls = research.trace.filter(({ type, name }) => (
        type === 'tool_call' && [
          'run_news_analysis', 'run_fundamental_analysis', 'run_technical_analysis',
        ].includes(name)
      ))
      assert.equal(launchCalls.length, 3)
      assert.ok(launchCalls.every(({ input }) => (
        input && typeof input.launch === 'boolean'
          && typeof input.researchQuestion === 'string'
          && typeof input.reason === 'string'
      )))
      assert.match(sse, /event: (completed|partial)/)
      assert.match(sse, /event: tool_call/)
      const [parallel] = sqlJson(`SELECT count(*)::integer AS count,
        max(e.created_at) < min(e.updated_at) AS overlapped
        FROM agent_sessions s JOIN agent_executions e ON e.session_id=s.id
        WHERE s.analysis_id=${literal(created.analysisId)} AND s.domain IS NOT NULL AND e.terminal=true`)
      assert.equal(parallel.count, 3)
      assert.equal(parallel.overlapped, true)
      assert.ok(reportVersionCount(created.analysisId, 'specialist') >= 3)
      assert.equal(reportVersionCount(created.analysisId), 1)
      console.log(JSON.stringify({
        phase: 'first-research', attempt, analysisId: created.analysisId,
        status: terminal.status, specialists: 3, parallel: true,
      }))
      return created
    } catch {
      console.log(JSON.stringify({
        phase: 'first-research-attempt', attempt, analysisId: created.analysisId,
        status: terminal.status, error: 'acceptance_failed',
      }))
    }
  }
  throw new Error('real Provider failed both first-research attempts')
}

async function verifyFollowUpAndCompaction(created) {
  const ordinary = await followUp(created.analysisId, {
    messageId: 'phase-2-e2e-chat-1', message: '请用一句话概括当前报告最重要的失效条件。',
    updateReport: false, baseReportVersion: 1,
  })
  await waitForTerminal(created.analysisId)
  assert.equal(reportVersionCount(created.analysisId), 1)
  const chatEvents = Number(sql(`SELECT count(*) FROM agent_events
    WHERE session_id=${literal(created.sessionId)} AND payload_json->>'type'='chat_completed'
      AND operation_id LIKE ${literal(`%${ordinary.executionId}%`)}`))
  assert.ok(chatEvents > 0)

  const reserveTokens = contextWindow - 73_000
  await json('/api/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ compactionReserveTokens: reserveTokens }),
  })
  let updated = await followUp(created.analysisId, {
    messageId: 'phase-2-e2e-report-v2',
    message: '请更新综合报告。为了分步核对：第一轮只决定消息面和基本面估值专项是否重跑；下一轮再决定技术面专项是否重跑；全部决定完成后再提交报告。若无需重跑，沿用基准报告已封存的精确专项版本。',
    updateReport: true, baseReportVersion: 1,
  })
  let terminal = await waitForTerminal(created.analysisId)
  assert.ok(reportVersionCount(created.analysisId) >= 2)
  let completed = sqlJson(`SELECT context_tokens,context_window,reserve_tokens,tokens_after
    FROM agent_compactions WHERE execution_id=${literal(updated.executionId)} ORDER BY created_at`)
  if (completed.length === 0) {
    const calibration = await followUp(created.analysisId, {
      messageId: 'phase-2-e2e-compaction-calibration',
      message: '请仅用一句话确认当前基准报告版本，不更新报告。',
      updateReport: false, baseReportVersion: reportVersionCount(created.analysisId),
    })
    await waitForTerminal(created.analysisId)
    const calibrationContextTokens = Number(sql(`SELECT coalesce(max((payload_json->>'contextTokens')::integer), 0)
      FROM agent_events
      WHERE operation_id LIKE ${literal(`%${updated.executionId}%`)}
        AND payload_json->>'type'='context_usage'`))
    const calibrationUsageTokens = Number(sql(`SELECT coalesce(max(total_tokens), 0) FROM model_requests
      WHERE execution_id=${literal(calibration.executionId)} AND kind='turn'`))
    const calibrationBaseline = calibrationContextTokens > 0
      ? calibrationContextTokens : calibrationUsageTokens
    const triggerTokens = Math.max(Math.floor(calibrationBaseline * 0.75), 30_000)
    assert.ok(triggerTokens > 0 && triggerTokens < contextWindow)
    await json('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ compactionReserveTokens: contextWindow - triggerTokens }),
    })
    updated = await followUp(created.analysisId, {
      messageId: 'phase-2-e2e-compaction-retry',
      message: '请再次更新综合报告。第一轮只决定消息面和基本面估值专项是否重跑；下一轮再决定技术面专项是否重跑；全部决定完成后再提交报告。若无需重跑，沿用基准报告已封存的精确专项版本。',
      updateReport: true, baseReportVersion: reportVersionCount(created.analysisId),
    })
    terminal = await waitForTerminal(created.analysisId)
    completed = sqlJson(`SELECT context_tokens,context_window,reserve_tokens,tokens_after
      FROM agent_compactions WHERE execution_id=${literal(updated.executionId)} ORDER BY created_at`)
  }
  assert.ok(completed.length > 0, 'real Provider did not produce a completed compaction')
  assert.ok(completed.every((item) => (
    item.tokens_after < item.context_tokens
      && item.tokens_after < item.context_window - item.reserve_tokens
  )))
  const attemptsWithoutUsage = Number(sql(`SELECT count(*) FROM agent_compaction_attempts
    WHERE execution_id=${literal(updated.executionId)} AND usage_json IS NULL`))
  assert.equal(attemptsWithoutUsage, 0)
  console.log(JSON.stringify({
    phase: 'follow-up-report-compaction', status: terminal.status,
    reportVersions: reportVersionCount(created.analysisId), compactions: completed.length,
  }))
}

async function verifyRestartResumeStopDelete(survivor) {
  const created = await createAnalysis('NVDA')
  await waitForActive(created.analysisId)
  const sharedFacts = await waitFor('shared facts', async () => Number(sql(`SELECT count(*) FROM analysis_facts a
    JOIN analysis_facts b USING (fact_id) WHERE a.analysis_id=${literal(survivor.analysisId)}
      AND b.analysis_id=${literal(created.analysisId)}`)), (count) => count > 0)
  const cursor = Number(sql(`SELECT latest_sequence FROM agent_sessions WHERE id=${literal(created.sessionId)}`))
  const modelRequestsBefore = Number(sql(`SELECT count(*) FROM model_requests WHERE execution_id=${literal(created.executionId)}`))

  execFileSync('docker', ['restart', analysisContainer], { stdio: 'ignore' })
  await waitForHealth()
  await waitFor('interrupted status', () => analysis(created.analysisId), (current) => current?.status === 'interrupted')
  await sleep(2000)
  assert.equal(Number(sql(`SELECT count(*) FROM model_requests WHERE execution_id=${literal(created.executionId)}`)), modelRequestsBefore)
  assert.ok((await json(`/api/research/${survivor.analysisId}`)).report)

  const resumed = await json(`/api/analyses/${created.analysisId}/resume`, { method: 'POST' }, 202)
  assert.equal(resumed.generation, 2)
  await waitForActive(created.analysisId)
  await waitFor('resumed model request', async () => Number(sql(`SELECT count(*) FROM model_requests
    WHERE execution_id=${literal(resumed.executionId)}`)), (count) => count > 0)
  await json(`/api/analyses/${created.analysisId}/cancel`, { method: 'POST' }, 202)
  await waitFor('stopped status', () => analysis(created.analysisId), (current) => current?.status === 'stopped')

  const sse = await replay(created.sessionId, cursor)
  assert.match(sse, /event: interrupted/)
  assert.match(sse, /event: stopping/)
  assert.match(sse, /event: stopped/)

  const sessionIds = sqlJson(`SELECT id FROM agent_sessions WHERE analysis_id=${literal(created.analysisId)}`).map(({ id }) => id)
  const executionIds = sqlJson(`SELECT e.id FROM agent_executions e JOIN agent_sessions s ON s.id=e.session_id
    WHERE s.analysis_id=${literal(created.analysisId)}`).map(({ id }) => id)
  const [stoppedTree] = sqlJson(`SELECT
    count(*)::integer AS sessions,
    count(*) FILTER (WHERE s.status = 'stopped' AND e.status = 'stopped' AND e.terminal)::integer AS stopped,
    count(*) FILTER (WHERE e.terminal = false)::integer AS active_executions
    FROM agent_sessions s JOIN agent_executions e ON e.id=s.execution_id
    WHERE s.analysis_id=${literal(created.analysisId)}`)
  assert.ok(stoppedTree.sessions > 0)
  assert.equal(stoppedTree.stopped, stoppedTree.sessions)
  assert.equal(stoppedTree.active_executions, 0)
  const [activeBatches] = sqlJson(`SELECT count(*)::integer AS count FROM tool_call_batches
    WHERE execution_id IN (${inList(executionIds)}) AND status = 'running'`)
  assert.equal(activeBatches.count, 0)
  const exclusiveFactIds = sqlJson(`SELECT fact_id AS id FROM analysis_facts own
    WHERE own.analysis_id=${literal(created.analysisId)}
      AND NOT EXISTS (SELECT 1 FROM analysis_facts other
        WHERE other.fact_id=own.fact_id AND other.analysis_id<>${literal(created.analysisId)})`)
    .map(({ id }) => id)
  assert.ok(exclusiveFactIds.length > 0)
  const batchIds = sqlJson(`SELECT b.id FROM tool_call_batches b
    WHERE b.execution_id IN (${inList(executionIds)})`).map(({ id }) => id)
  const deletion = await request(`/api/research/${created.analysisId}`, { method: 'DELETE' })
  assert.equal(deletion.response.status, 204, `/api/research/${created.analysisId}: ${deletion.response.status}`)
  assert.equal((await request(`/api/research/${created.analysisId}`)).response.status, 404)

  const [counts] = sqlJson(`SELECT
    (SELECT count(*)::integer FROM analyses WHERE id=${literal(created.analysisId)}) AS analyses,
    (SELECT count(*)::integer FROM analysis_facts WHERE analysis_id=${literal(created.analysisId)}) AS facts,
    (SELECT count(*)::integer FROM analysis_trace WHERE analysis_id=${literal(created.analysisId)}) AS trace,
    (SELECT count(*)::integer FROM agent_sessions WHERE id IN (${inList(sessionIds)})) AS sessions,
    (SELECT count(*)::integer FROM agent_executions WHERE id IN (${inList(executionIds)})) AS executions,
    (SELECT count(*)::integer FROM conversation_segments WHERE session_id IN (${inList(sessionIds)})) AS segments,
    (SELECT count(*)::integer FROM agent_events WHERE session_id IN (${inList(sessionIds)})) AS events,
    (SELECT count(*)::integer FROM execution_settings_snapshots WHERE execution_id IN (${inList(executionIds)})) AS settings,
    (SELECT count(*)::integer FROM tool_projection_versions WHERE execution_id IN (${inList(executionIds)})) AS projections,
    (SELECT count(*)::integer FROM model_requests WHERE execution_id IN (${inList(executionIds)})) AS requests,
    (SELECT count(*)::integer FROM tool_call_batches WHERE id IN (${inList(batchIds)})) AS batches,
    (SELECT count(*)::integer FROM tool_batch_calls WHERE batch_id IN (${inList(batchIds)})) AS calls,
    (SELECT count(*)::integer FROM agent_compactions WHERE session_id IN (${inList(sessionIds)})) AS compactions,
    (SELECT count(*)::integer FROM agent_compaction_attempts WHERE session_id IN (${inList(sessionIds)})) AS attempts,
    (SELECT count(*)::integer FROM report_versions WHERE analysis_id=${literal(created.analysisId)}) AS reports,
    (SELECT count(*)::integer FROM analysis_deletion_tombstones WHERE analysis_id=${literal(created.analysisId)}) AS tombstones`)
  assert.deepEqual(counts, {
    analyses: 0, facts: 0, trace: 0, sessions: 0, executions: 0, segments: 0,
    events: 0, settings: 0, projections: 0, requests: 0, batches: 0, calls: 0,
    compactions: 0, attempts: 0, reports: 0, tombstones: 1,
  })
  const [exclusiveFacts] = sqlJson(`SELECT count(*)::integer AS count FROM atomic_facts
    WHERE id IN (${inList(exclusiveFactIds)})`)
  assert.equal(exclusiveFacts.count, 0)
  const [retained] = sqlJson(`SELECT count(*)::integer AS references,
    count(f.id)::integer AS atomic_facts FROM analysis_facts af
    LEFT JOIN atomic_facts f ON f.id=af.fact_id WHERE af.analysis_id=${literal(survivor.analysisId)}`)
  assert.ok(retained.references >= sharedFacts)
  assert.equal(retained.atomic_facts, retained.references)
  console.log(JSON.stringify({
    phase: 'restart-resume-stop-delete', interrupted: true, resumedGeneration: 2,
    stopped: true, deleted: true, sharedFacts,
  }))
}

await verifyInfrastructure()
const first = await verifyFirstResearch()
await verifyFollowUpAndCompaction(first)
await verifyRestartResumeStopDelete(first)
console.log(JSON.stringify({ phase: 'complete', analysisId: first.analysisId, status: 'passed' }))
