import { Pool } from 'pg'
import { terminalAgentExecutionStatuses, type ConversationThread } from '@vibe-invest/contracts'
import { freezeExecutionSettings } from './settings.js'
import { type AgentEventRow } from './agent-runtime.js'
import { jsonValuesEqual } from './values.js'

export type AnalysisRecord = {
  id: string
  symbol: string
  status: string
  createdAt: string
  updatedAt: string
  snapshot: unknown
  report: unknown
  reportCreatedAt: string | null
  error: string | null
  starred: boolean
  note: string
  terminal?: boolean
}

type AnalysisRow = {
  id: string; symbol: string; status: string; created_at: string; updated_at: string
  snapshot_json: unknown; report_json: unknown; report_created_at: string | null
  error: string | null; starred: boolean; note: string
  terminal?: boolean | null
}

export function createAnalysisRepository(pool: Pool) {
  const terminal = terminalAgentExecutionStatuses
  return {
    async setStatus(id: string, status: string, updatedAt: string, extra: {
      report?: unknown; snapshot?: unknown; error?: string
    } = {}) {
      await pool.query(
        `UPDATE analyses SET status = $1, updated_at = $2,
           report_json = COALESCE($3::jsonb, report_json),
           report_created_at = CASE WHEN $3::jsonb IS NULL THEN report_created_at ELSE $2 END,
           snapshot_json = COALESCE($4::jsonb, snapshot_json),
           error = COALESCE($5, error) WHERE id = $6`,
        [status, updatedAt, extra.report ? JSON.stringify(extra.report) : null,
          extra.snapshot ? JSON.stringify(extra.snapshot) : null, extra.error ?? null, id],
      )
    },
    async get(id: string) {
      const result = await pool.query<AnalysisRow>(
        `SELECT analysis.*,
           CASE WHEN event.payload_json->>'terminal' IS NULL THEN NULL
             ELSE (event.payload_json->>'terminal')::boolean END AS terminal
         FROM analyses analysis
         LEFT JOIN agent_sessions session
           ON session.analysis_id = analysis.id AND session.is_primary
         LEFT JOIN agent_events event
           ON event.session_id = session.id AND event.sequence = session.latest_sequence
         WHERE analysis.id = $1 AND analysis.kind = 'research'`, [id],
      )
      return result.rows[0] ? mapAnalysisRow(result.rows[0]) : null
    },
    async claimNextQueued(updatedAt: string) {
      const result = await pool.query<{ id: string }>(
        `WITH candidate AS (
           SELECT id FROM analyses
           WHERE status = 'queued' AND kind = 'research'
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE analyses SET status = 'running', updated_at = $1
         FROM candidate
         WHERE analyses.id = candidate.id
         RETURNING analyses.id`, [updatedAt],
      )
      return result.rows[0]?.id ?? null
    },
    async saveSnapshot(id: string, snapshot: unknown) {
      await pool.query(
        `UPDATE analyses SET snapshot_json = $1
         WHERE id = $2 AND NOT (status = ANY($3::text[]))`,
        [JSON.stringify(snapshot), id, terminal],
      )
    },
    async research(id: string, projection: 'view' | 'export' = 'export') {
      const analysis = projection === 'export' ? await this.get(id) : await pool.query<AnalysisRow>(
        `SELECT analysis.id, analysis.symbol, analysis.status,
                analysis.created_at, analysis.updated_at,
                NULL::jsonb AS snapshot_json, analysis.report_json,
                analysis.report_created_at, analysis.error, analysis.starred, analysis.note,
           CASE WHEN event.payload_json->>'terminal' IS NULL THEN NULL
             ELSE (event.payload_json->>'terminal')::boolean END AS terminal
         FROM analyses analysis
         LEFT JOIN agent_sessions session
           ON session.analysis_id = analysis.id AND session.is_primary
         LEFT JOIN agent_events event
           ON event.session_id = session.id AND event.sequence = session.latest_sequence
         WHERE analysis.id = $1 AND analysis.kind = 'research'`, [id],
      ).then((result) => result.rows[0] ? mapAnalysisRow(result.rows[0]) : null)
      if (!analysis) return null
      const facts = await pool.query<{ payload_json: unknown }>(
        `SELECT f.payload_json FROM atomic_facts f
         JOIN analysis_facts af ON af.fact_id = f.id WHERE af.analysis_id = $1`, [id],
      )
      return { ...analysis, facts: facts.rows.map((row) => row.payload_json) }
    },
    async listResearch(symbol?: string) {
      const params: unknown[] = [terminal]
      const condition = symbol
        ? "symbol = $2 AND kind = 'research' AND status = ANY($1)"
        : "kind = 'research' AND status = ANY($1)"
      if (symbol) params.push(symbol.toUpperCase())
      const result = await pool.query<AnalysisRow>(
        `SELECT id, symbol, status, created_at, updated_at,
                NULL::jsonb AS snapshot_json,
                CASE WHEN report_json IS NULL THEN NULL ELSE jsonb_build_object(
                  'title', report_json->'title', 'trend', report_json->'trend'
                ) END AS report_json,
                report_created_at,
                error, starred, note
         FROM analyses WHERE ${condition} ORDER BY created_at DESC`, params,
      )
      return result.rows.map((row) => {
        const { snapshot: _snapshot, ...summary } = mapAnalysisRow(row)
        return summary
      })
    },
    async updateResearch(id: string, values: { starred?: boolean; note?: string }, updatedAt: string) {
      const result = await pool.query<AnalysisRow>(
        `UPDATE analyses SET starred = COALESCE($1, starred), note = COALESCE($2, note), updated_at = $3
         WHERE id = $4 AND kind = 'research' RETURNING *`, [values.starred ?? null, values.note ?? null, updatedAt, id],
      )
      return result.rows[0] ? mapAnalysisRow(result.rows[0]) : null
    },
    async removeResearch(id: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id])
        const analysis = await client.query(
          "SELECT id FROM analyses WHERE id = $1 AND kind = 'research' FOR UPDATE", [id],
        )
        if (!analysis.rowCount) { await client.query('ROLLBACK'); return false }
        const running = await client.query(
          `SELECT 1 FROM agent_sessions session
           JOIN agent_executions execution ON execution.id = session.execution_id
           WHERE session.analysis_id = $1 AND execution.terminal = false LIMIT 1`, [id],
        )
        if (running.rowCount) throw new Error('analysis_not_stopped')
        await client.query(
          `INSERT INTO analysis_deletion_tombstones (analysis_id, deleted_at)
           VALUES ($1, now()) ON CONFLICT (analysis_id) DO NOTHING`, [id],
        )
        await client.query(
          `DELETE FROM execution_settings_snapshots snapshot
           USING agent_executions execution, agent_sessions session
           WHERE snapshot.execution_id = execution.id
             AND execution.session_id = session.id AND session.analysis_id = $1`, [id],
        )
        await client.query('DELETE FROM analyses WHERE id = $1', [id])
        await client.query('DELETE FROM atomic_facts WHERE id NOT IN (SELECT fact_id FROM analysis_facts)')
        await client.query('COMMIT')
        return true
      } catch (error) {
        await client.query('ROLLBACK'); throw error
      } finally { client.release() }
    },
  }
}

export type AnalysisRepository = ReturnType<typeof createAnalysisRepository>

export type ConversationThreadInput = {
  id: string
  sessionId: string
  executionId: string
  segmentId: string
  title?: string | null
  parentThreadId?: string | null
  operationId: string
  event: Record<string, unknown>
  createdAt: string
}

export type ConversationRunInput = {
  threadId: string
  executionId: string
  segmentId: string
  operationId: string
  event: Record<string, unknown>
  createdAt: string
}

/**
 * Conversation storage intentionally reuses the existing analysis/session
 * ledger during the migration.  The public interface is Thread-shaped, while
 * legacy research queries remain filtered to kind = research.
 */
export function createConversationRepository(pool: Pool) {
  const mapStatus = (status: string): ConversationThread['status'] => {
    if (status === 'queued') return 'queued'
    if (status === 'completed' || status === 'partial') return 'completed'
    if (status === 'failed') return 'failed'
    if (status === 'stopped') return 'stopped'
    if (status === 'interrupted') return 'interrupted'
    return 'running'
  }
  const read = async (id: string): Promise<ConversationThread | null> => {
    const result = await pool.query<{
      id: string; title: string | null; status: string; created_at: string; updated_at: string
      session_id: string | null; execution_id: string | null; parent_id: string | null
    }>(
      `SELECT analysis.id, analysis.note AS title, analysis.status, analysis.parent_id,
              analysis.created_at::text, analysis.updated_at::text,
              session.id AS session_id, session.execution_id
       FROM analyses analysis
       LEFT JOIN agent_sessions session
         ON session.analysis_id = analysis.id AND session.is_primary
       WHERE analysis.id = $1 AND analysis.kind = 'conversation'`, [id],
    )
    const row = result.rows[0]
    if (!row || !row.session_id || !row.execution_id) return null
    return {
      id: row.id, capability: 'research', title: row.title, parentThreadId: row.parent_id,
      status: mapStatus(row.status),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      sessionId: row.session_id, executionId: row.execution_id,
    }
  }
  return {
    async create(input: ConversationThreadInput) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM analyses WHERE id = $1 AND kind = 'conversation' FOR UPDATE`, [input.id],
        )
        if (existing.rows[0]) {
          await client.query('COMMIT')
          return { thread: await read(input.id), created: false }
        }
        await client.query(
          `INSERT INTO analyses (id, symbol, kind, parent_id, status, active, created_at, updated_at, note)
           VALUES ($1, NULL, 'conversation', $2, 'queued', true, $3, $3, $4)`,
          [input.id, input.parentThreadId ?? null, input.createdAt, input.title ?? ''],
        )
        await client.query(
          `INSERT INTO agent_sessions (
             id, analysis_id, is_primary, execution_id, status, latest_sequence, created_at, updated_at
           ) VALUES ($1, $2, true, $3, 'planning', 1, $4, $4)`,
          [input.sessionId, input.id, input.executionId, input.createdAt],
        )
        await client.query(
          `INSERT INTO agent_executions (
             id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
           ) VALUES ($1, $2, 1, 'planning', $3, false, $4, $4)`,
          [input.executionId, input.sessionId, JSON.stringify({
            kind: 'database', target: '对话初始化', startedAt: input.createdAt,
          }), input.createdAt],
        )
        await client.query(
          `INSERT INTO conversation_segments (id, session_id, ordinal, created_at)
           VALUES ($1, $2, 1, $3)`, [input.segmentId, input.sessionId, input.createdAt],
        )
        await client.query(
          `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
           VALUES ($1, 1, $2, $3, $4)`,
          [input.sessionId, input.operationId, JSON.stringify(input.event), input.createdAt],
        )
        await freezeExecutionSettings(client, input.executionId, input.createdAt)
        await client.query('COMMIT')
        return { thread: await read(input.id), created: true }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    get: read,
    async list() {
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM analyses WHERE kind = 'conversation' ORDER BY updated_at DESC`,
      )
      return (await Promise.all(result.rows.map(({ id }) => read(id))))
        .filter((thread): thread is ConversationThread => thread !== null)
    },
    async listChildren(parentThreadId: string) {
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM analyses WHERE kind = 'conversation' AND parent_id = $1 ORDER BY created_at`,
        [parentThreadId],
      )
      return (await Promise.all(result.rows.map(({ id }) => read(id))))
        .filter((thread): thread is ConversationThread => thread !== null)
    },
    async claimNextQueued(updatedAt: string) {
      const result = await pool.query<{ id: string }>(
        `WITH candidate AS (
           SELECT id FROM analyses
           WHERE kind = 'conversation' AND status = 'queued'
           ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE analyses SET status = 'running', updated_at = $1
         FROM candidate WHERE analyses.id = candidate.id
         RETURNING analyses.id`, [updatedAt],
      )
      return result.rows[0]?.id ?? null
    },
    async createRun(input: ConversationRunInput) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const thread = await client.query<{ status: string }>(
          `SELECT status FROM analyses WHERE id = $1 AND kind = 'conversation' FOR UPDATE`,
          [input.threadId],
        )
        if (!thread.rows[0]) throw new Error('conversation_not_found')
        const session = await client.query<{
          id: string; execution_id: string; latest_sequence: number
        }>(
          `SELECT id, execution_id, latest_sequence FROM agent_sessions
           WHERE analysis_id = $1 AND is_primary FOR UPDATE`, [input.threadId],
        )
        if (!session.rows[0]) throw new Error('conversation_session_not_found')
        const current = await client.query<{ generation: number; status: string; terminal: boolean }>(
          `SELECT generation, status, terminal FROM agent_executions WHERE id = $1 FOR UPDATE`,
          [session.rows[0].execution_id],
        )
        if (!current.rows[0]) throw new Error('conversation_execution_not_found')
        const replay = await client.query<AgentEventRow>(
          `SELECT session_id, sequence, operation_id, payload_json, created_at::text
           FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
          [session.rows[0].id, input.operationId],
        )
        if (replay.rows[0]) {
          if (!jsonValuesEqual(replay.rows[0].payload_json, input.event)) {
            throw new Error('agent_operation_conflict')
          }
          await client.query('COMMIT')
          return {
            sessionId: session.rows[0].id, executionId: session.rows[0].execution_id,
            generation: current.rows[0].generation, created: false,
          }
        }
        if (!current.rows[0].terminal) throw new Error('conversation_run_active')
        const generation = current.rows[0].generation + 1
        const sequence = session.rows[0].latest_sequence + 1
        const ordinal = await client.query<{ ordinal: number }>(
          `SELECT COALESCE(max(ordinal), 0)::integer + 1 AS ordinal
           FROM conversation_segments WHERE session_id = $1`, [session.rows[0].id],
        )
        await client.query(
          `INSERT INTO agent_executions (
             id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
           ) VALUES ($1, $2, $3, 'planning', $4, false, $5, $5)`,
          [input.executionId, session.rows[0].id, generation, JSON.stringify({
            kind: 'database', target: '组装对话上下文', startedAt: input.createdAt,
          }), input.createdAt],
        )
        await client.query(
          `INSERT INTO conversation_segments (id, session_id, ordinal, parent_segment_id, created_at)
           VALUES ($1, $2, $3, (SELECT id FROM conversation_segments WHERE session_id = $2 ORDER BY ordinal DESC LIMIT 1), $4)`,
          [input.segmentId, session.rows[0].id, ordinal.rows[0]!.ordinal, input.createdAt],
        )
        await client.query(
          `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [session.rows[0].id, sequence, input.operationId, JSON.stringify(input.event), input.createdAt],
        )
        await freezeExecutionSettings(client, input.executionId, input.createdAt)
        await client.query(
          `UPDATE agent_sessions SET execution_id = $1, status = 'planning', latest_sequence = $2,
             updated_at = $3 WHERE id = $4`,
          [input.executionId, sequence, input.createdAt, session.rows[0].id],
        )
        await client.query(
          `UPDATE analyses SET status = 'queued', active = true, error = NULL, updated_at = $1
           WHERE id = $2 AND kind = 'conversation'`, [input.createdAt, input.threadId],
        )
        await client.query('COMMIT')
        return {
          sessionId: session.rows[0].id, executionId: input.executionId,
          generation, created: true,
        }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async setStatus(id: string, status: string, updatedAt: string, error?: string) {
      await pool.query(
        `UPDATE analyses SET status = $1, active = $2, error = COALESCE($3, error), updated_at = $4
         WHERE id = $5 AND kind = 'conversation'`,
        [status, !terminalAgentExecutionStatuses.some((item) => item === status), error ?? null, updatedAt, id],
      )
    },
  }
}

export type ConversationRepository = ReturnType<typeof createConversationRepository>

function mapAnalysisRow(row: AnalysisRow): AnalysisRecord {
  return {
    id: row.id, symbol: row.symbol, status: row.status,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    snapshot: row.snapshot_json, report: row.report_json, error: row.error,
    reportCreatedAt: row.report_created_at ? new Date(row.report_created_at).toISOString() : null,
    starred: row.starred, note: row.note,
    ...(row.terminal === null || row.terminal === undefined ? {} : { terminal: row.terminal }),
  }
}
