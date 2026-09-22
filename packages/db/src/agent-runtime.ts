import { Pool, type PoolClient } from 'pg'
import { agentExecutionStatuses, aggregateModelTokenUsage, terminalAgentExecutionStatuses, type AgentExecutionStatus } from '@vibe-invest/contracts'
import { jsonValuesEqual, sameInstant, nullableInstantsEqual } from './values.js'
import { freezeExecutionSettings } from './settings.js'

export type AgentEvent = {
  sessionId: string
  sequence: number
  operationId: string
  payload: Record<string, unknown>
  createdAt: string
}

export type AgentSession = {
  id: string
  analysisId: string
  status: string
  isPrimary: boolean
  executionId: string
  latestSequence: number
  createdAt: string
  updatedAt: string
}

export type AgentEventRow = {
  session_id: string
  sequence: number
  operation_id: string
  payload_json: Record<string, unknown>
  created_at: string
}

type AgentSessionRow = {
  id: string
  analysis_id: string
  status: string
  is_primary: boolean
  execution_id: string
  latest_sequence: number
  created_at: string
  updated_at: string
}

export function createAgentEventRepository(pool: Pool) {
  return {
    async fenceForStopping(input: {
      sessionId: string; executionId: string; fenceExecutionId: string
      operationId: string; event: Record<string, unknown>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const sessionIdentity = await client.query<{ analysis_id: string }>(
          'SELECT analysis_id FROM agent_sessions WHERE id = $1', [input.sessionId],
        )
        if (!sessionIdentity.rows[0]) throw new Error('agent_session_not_found')
        await client.query(
          'SELECT id FROM analyses WHERE id = $1 FOR UPDATE',
          [sessionIdentity.rows[0].analysis_id],
        )
        const session = await client.query<{
          latest_sequence: number; analysis_id: string; is_primary: boolean; execution_id: string
        }>(
          `SELECT latest_sequence, analysis_id, is_primary, execution_id
           FROM agent_sessions WHERE id = $1 FOR UPDATE`, [input.sessionId],
        )
        if (!session.rows[0]) throw new Error('agent_session_not_found')
        if (session.rows[0].execution_id !== input.executionId) {
          const existing = await client.query<AgentEventRow>(
            `SELECT session_id, sequence, operation_id, payload_json, created_at::text
             FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
            [input.sessionId, input.operationId],
          )
          const row = existing.rows[0]
          if (!row || session.rows[0].execution_id !== input.fenceExecutionId
            || !jsonValuesEqual(row.payload_json, input.event)
            || !sameInstant(row.created_at, input.createdAt)) throw new Error('agent_execution_fenced')
          const cancelled = await client.query<AgentEventRow>(
            `SELECT e.session_id, e.sequence, e.operation_id, e.payload_json, e.created_at::text
             FROM agent_events e JOIN agent_sessions s ON s.id = e.session_id
             WHERE s.analysis_id = $1 AND e.created_at = $2
               AND e.operation_id LIKE '%:cancelled-%' ORDER BY e.session_id, e.sequence`,
            [session.rows[0].analysis_id, input.createdAt],
          )
          const fenced = await client.query<AgentEventRow & { execution_id: string }>(
            `SELECT e.session_id, e.sequence, e.operation_id, e.payload_json, e.created_at::text,
                    s.execution_id
             FROM agent_events e JOIN agent_sessions s ON s.id = e.session_id
             WHERE s.analysis_id = $1 AND e.created_at = $2
               AND e.payload_json->>'status' = 'stopping' ORDER BY e.session_id`,
            [session.rows[0].analysis_id, input.createdAt],
          )
          await client.query('COMMIT')
          return {
            ...mapAgentEventRow(row), executionId: input.fenceExecutionId,
            cancelledToolEvents: cancelled.rows.map(mapAgentEventRow),
            fencedSessions: fenced.rows.map((event) => ({
              ...mapAgentEventRow(event), executionId: event.execution_id,
            })),
          }
        }
        const sessions = await client.query<{
          id: string; execution_id: string; latest_sequence: number; is_primary: boolean
        }>(
          `SELECT id, execution_id, latest_sequence, is_primary FROM agent_sessions
           WHERE analysis_id = $1 ORDER BY id FOR UPDATE`, [session.rows[0].analysis_id],
        )
        const fencedSessions: Array<AgentEvent & { executionId: string }> = []
        const cancelledToolEvents: AgentEvent[] = []
        for (const currentSession of sessions.rows) {
          const execution = await client.query<{ generation: number; terminal: boolean }>(
            'SELECT generation, terminal FROM agent_executions WHERE id = $1 FOR UPDATE',
            [currentSession.execution_id],
          )
          if (!execution.rows[0]) throw new Error('agent_execution_not_found')
          if (execution.rows[0].terminal) {
            if (currentSession.id === input.sessionId) throw new Error('agent_execution_terminal')
            continue
          }
          const cancelled = await cancelRunningToolBatches(
            client, currentSession.id, currentSession.execution_id,
            currentSession.latest_sequence, input.createdAt,
          )
          cancelledToolEvents.push(...cancelled.events)
          await cancelRunningCompactionAttempts(
            client, currentSession.id, currentSession.execution_id, input.createdAt,
          )
          await finalizeRunningModelRequests(
            client, currentSession.execution_id, 'cancelled', input.createdAt,
          )
          const sequence = cancelled.latestSequence + 1
          const waitReason = input.event.waitReason ?? null
          const fenceExecutionId = currentSession.id === input.sessionId
            ? input.fenceExecutionId : `${input.fenceExecutionId}:session:${currentSession.id}`
          const operationId = currentSession.id === input.sessionId
            ? input.operationId : `${input.operationId}:session:${currentSession.id}`
          await client.query(
            'UPDATE agent_executions SET terminal = true, updated_at = $1 WHERE id = $2',
            [input.createdAt, currentSession.execution_id],
          )
          await client.query(
            `INSERT INTO agent_executions (
               id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
             ) VALUES ($1, $2, $3, 'stopping', $4, false, $5, $5)`,
            [fenceExecutionId, currentSession.id, execution.rows[0].generation + 1,
              waitReason ? JSON.stringify(waitReason) : null, input.createdAt],
          )
          const eventPayload = currentSession.id === input.sessionId ? input.event : {
            ...input.event, previousExecutionId: currentSession.execution_id,
          }
          await client.query(
            `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [currentSession.id, sequence, operationId, JSON.stringify(eventPayload), input.createdAt],
          )
          await client.query(
            `UPDATE agent_sessions SET execution_id = $1, status = 'stopping', latest_sequence = $2,
               updated_at = $3 WHERE id = $4`,
            [fenceExecutionId, sequence, input.createdAt, currentSession.id],
          )
          fencedSessions.push({
            sessionId: currentSession.id, sequence, operationId, payload: eventPayload,
            createdAt: input.createdAt, executionId: fenceExecutionId,
          })
        }
        if (session.rows[0].is_primary) await client.query(
          `UPDATE analyses SET status = 'stopping', active = true, updated_at = $1 WHERE id = $2`,
          [input.createdAt, session.rows[0].analysis_id],
        )
        await client.query('COMMIT')
        const primary = fencedSessions.find(({ sessionId }) => sessionId === input.sessionId)!
        return { ...primary, cancelledToolEvents, fencedSessions }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async createResearch(input: {
      analysisId: string
      sessionId: string
      executionId: string
      segmentId?: string
      symbol: string
      status: string
      analysisStatus?: string
      operationId: string
      event: Record<string, unknown>
      createdAt: string
    }) {
      const client = await pool.connect()
      let conflictedAnalysisId: string | undefined
      try {
        await client.query('BEGIN')
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.analysisId],
        )
        const deleted = await client.query(
          'SELECT 1 FROM analysis_deletion_tombstones WHERE analysis_id = $1', [input.analysisId],
        )
        if (deleted.rowCount) throw new Error('analysis_deleted')
        const analysis = await client.query<{ id: string; created: boolean }>(
          `INSERT INTO analyses (id, symbol, status, active, created_at, updated_at)
           VALUES ($1, $2, $3, true, $4, $4)
           ON CONFLICT (symbol) WHERE active AND kind = 'research' AND symbol IS NOT NULL
           DO UPDATE SET symbol = excluded.symbol
           RETURNING id, id = $1 AS created`,
          [input.analysisId, input.symbol, input.analysisStatus ?? input.status, input.createdAt],
        )
        const analysisId = analysis.rows[0]!.id
        if (!analysis.rows[0]!.created) {
          await client.query('COMMIT')
          conflictedAnalysisId = analysisId
        } else {
          await client.query(
            `INSERT INTO agent_sessions (
               id, analysis_id, is_primary, execution_id, status, latest_sequence, created_at, updated_at
             ) VALUES ($1, $2, true, $3, $4, 1, $5, $5)`,
            [input.sessionId, analysisId, input.executionId, input.status, input.createdAt],
          )
          const segmentId = input.segmentId ?? `${input.sessionId}:segment:1`
          const waitReason = {
            kind: 'database', target: '首次研究初始化', startedAt: input.createdAt,
          }
          await client.query(
            `INSERT INTO agent_executions (
               id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
             ) VALUES ($1, $2, 1, 'planning', $3, false, $4, $4)`,
            [input.executionId, input.sessionId, JSON.stringify(waitReason), input.createdAt],
          )
          await client.query(
            `INSERT INTO conversation_segments (id, session_id, ordinal, created_at)
             VALUES ($1, $2, 1, $3)`,
            [segmentId, input.sessionId, input.createdAt],
          )
          await client.query(
            `INSERT INTO agent_events (
               session_id, sequence, operation_id, payload_json, created_at
             ) VALUES ($1, 1, $2, $3, $4)`,
            [input.sessionId, input.operationId, JSON.stringify(input.event), input.createdAt],
          )
          await freezeExecutionSettings(client, input.executionId, input.createdAt)
          await client.query('COMMIT')
          return { analysisId, sessionId: input.sessionId, sequence: 1, created: true, event: {
            sessionId: input.sessionId, sequence: 1, operationId: input.operationId,
            payload: input.event, createdAt: input.createdAt,
          } }
        }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
      // 冲突路径的后续读取必须在释放连接之后进行：
      // 持有连接时再经 pool 读取会在连接耗尽时互相等待（并发重复创建场景）。
      if (conflictedAnalysisId) {
        const existing = await this.findPrimarySession(conflictedAnalysisId)
        if (!existing) throw new Error('agent_session_not_found')
        const event = (await this.list(existing.id, 0))[0]!
        return {
          analysisId: conflictedAnalysisId, sessionId: existing.id,
          sequence: event.sequence, created: false, event,
        }
      }
      throw new Error('agent_research_create_state_missing')
    },
    async resumeResearch(input: {
      analysisId: string; executionId: string; segmentId?: string
      operationId: string; event: Record<string, unknown>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const analysis = await client.query<{ status: string }>(
          'SELECT status FROM analyses WHERE id = $1 FOR UPDATE', [input.analysisId],
        )
        if (!analysis.rows[0]) throw new Error('analysis_not_found')
        const session = await client.query<{
          id: string; execution_id: string; latest_sequence: number
        }>(
          `SELECT id, execution_id, latest_sequence FROM agent_sessions
           WHERE analysis_id = $1 AND is_primary FOR UPDATE`, [input.analysisId],
        )
        if (!session.rows[0]) throw new Error('agent_session_not_found')
        const current = await client.query<{
          id: string; generation: number; status: string; terminal: boolean
        }>(
          `SELECT id, generation, status, terminal FROM agent_executions
           WHERE id = $1 FOR UPDATE`, [session.rows[0].execution_id],
        )
        if (!current.rows[0]) throw new Error('agent_execution_not_found')
        const replay = await client.query<AgentEventRow>(
          `SELECT session_id, sequence, operation_id, payload_json, created_at::text
           FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
          [session.rows[0].id, input.operationId],
        )
        if (replay.rows[0]) {
          const execution = await client.query<{ session_id: string; generation: number }>(
            'SELECT session_id, generation FROM agent_executions WHERE id = $1', [input.executionId],
          )
          if (execution.rows[0]?.session_id !== session.rows[0].id
            || !jsonValuesEqual(replay.rows[0].payload_json, input.event)
            || !sameInstant(replay.rows[0].created_at, input.createdAt)) {
            throw new Error('agent_operation_conflict')
          }
          await client.query('COMMIT')
          return {
            sessionId: session.rows[0].id, executionId: input.executionId,
            generation: execution.rows[0].generation, created: false,
          }
        }
        if (!current.rows[0].terminal
          || !['stopped', 'interrupted'].includes(current.rows[0].status)
          || !['stopped', 'interrupted'].includes(analysis.rows[0].status)) {
          throw new Error('analysis_not_resumable')
        }
        const generation = current.rows[0].generation + 1
        const sequence = session.rows[0].latest_sequence + 1
        const segment = await client.query<{ next_ordinal: number }>(
          `SELECT COALESCE(max(ordinal), 0)::integer + 1 AS next_ordinal
           FROM conversation_segments WHERE session_id = $1`, [session.rows[0].id],
        )
        const ordinal = segment.rows[0]!.next_ordinal
        const waitReason = { kind: 'database', target: '恢复研究上下文', startedAt: input.createdAt }
        await client.query(
          `INSERT INTO agent_executions (
             id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
           ) VALUES ($1, $2, $3, 'planning', $4, false, $5, $5)`,
          [input.executionId, session.rows[0].id, generation,
            JSON.stringify(waitReason), input.createdAt],
        )
        await client.query(
          `INSERT INTO conversation_segments (id, session_id, ordinal, created_at)
           VALUES ($1, $2, $3, $4)`,
          [input.segmentId ?? `${session.rows[0].id}:segment:${ordinal}`,
            session.rows[0].id, ordinal, input.createdAt],
        )
        await client.query(
          `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [session.rows[0].id, sequence, input.operationId,
            JSON.stringify(input.event), input.createdAt],
        )
        await freezeExecutionSettings(client, input.executionId, input.createdAt)
        await client.query(
          `UPDATE agent_sessions SET execution_id = $1, status = 'planning', latest_sequence = $2,
             updated_at = $3 WHERE id = $4`,
          [input.executionId, sequence, input.createdAt, session.rows[0].id],
        )
        await client.query(
          `UPDATE analyses SET status = 'queued', active = true, error = NULL, updated_at = $1
           WHERE id = $2`, [input.createdAt, input.analysisId],
        )
        await client.query('COMMIT')
        return {
          sessionId: session.rows[0].id, executionId: input.executionId, generation, created: true,
        }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async createFollowUpExecution(input: {
      analysisId: string; executionId: string; segmentId?: string
      baseReportVersion: number | null; operationId: string
      event: Record<string, unknown>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const eventBaseReportVersion = typeof input.event.baseReportVersion === 'number'
          ? input.event.baseReportVersion : input.event.baseReportVersion === null ? null : undefined
        if (eventBaseReportVersion !== input.baseReportVersion) {
          throw new Error('agent_operation_conflict')
        }
        const analysis = await client.query<{ status: string }>(
          'SELECT status FROM analyses WHERE id = $1 FOR UPDATE', [input.analysisId],
        )
        if (!analysis.rows[0]) throw new Error('analysis_not_found')
        const session = await client.query<{
          id: string; execution_id: string; latest_sequence: number
        }>(
          `SELECT id, execution_id, latest_sequence FROM agent_sessions
           WHERE analysis_id = $1 AND is_primary FOR UPDATE`, [input.analysisId],
        )
        if (!session.rows[0]) throw new Error('agent_session_not_found')
        const replay = await client.query<AgentEventRow>(
          `SELECT session_id, sequence, operation_id, payload_json, created_at::text
           FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
          [session.rows[0].id, input.operationId],
        )
        if (replay.rows[0]) {
          const execution = await client.query<{ session_id: string; generation: number }>(
            'SELECT session_id, generation FROM agent_executions WHERE id = $1',
            [input.executionId],
          )
          if (execution.rows[0]?.session_id !== session.rows[0].id
            || !jsonValuesEqual(replay.rows[0].payload_json, input.event)) {
            throw new Error('agent_operation_conflict')
          }
          await client.query('COMMIT')
          return {
            sessionId: session.rows[0].id, executionId: input.executionId,
            generation: execution.rows[0].generation,
            baseReportVersion: eventBaseReportVersion, created: false,
          }
        }
        const current = await client.query<{
          generation: number; status: string; terminal: boolean
        }>(
          `SELECT generation, status, terminal FROM agent_executions WHERE id = $1 FOR UPDATE`,
          [session.rows[0].execution_id],
        )
        if (!current.rows[0]?.terminal) throw new Error('analysis_follow_up_not_available')
        if (['stopped', 'interrupted'].includes(current.rows[0].status)) {
          throw new Error('analysis_resume_required')
        }
        if (input.baseReportVersion !== null) {
          const report = await client.query(
            `SELECT id FROM report_versions
             WHERE analysis_id = $1 AND session_id = $2 AND version = $3 AND kind = 'integrated'`,
            [input.analysisId, session.rows[0].id, input.baseReportVersion],
          )
          if (!report.rowCount) throw new Error('base_report_version_not_found')
        }
        const generation = current.rows[0].generation + 1
        const sequence = session.rows[0].latest_sequence + 1
        const ordinalResult = await client.query<{ ordinal: number }>(
          `SELECT COALESCE(max(ordinal), 0)::integer + 1 AS ordinal
           FROM conversation_segments WHERE session_id = $1`, [session.rows[0].id],
        )
        const ordinal = ordinalResult.rows[0]!.ordinal
        const waitReason = {
          kind: 'database', target: '组装追问上下文', startedAt: input.createdAt,
        }
        await client.query(
          `INSERT INTO agent_executions (
             id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
           ) VALUES ($1, $2, $3, 'planning', $4, false, $5, $5)`,
          [input.executionId, session.rows[0].id, generation,
            JSON.stringify(waitReason), input.createdAt],
        )
        await client.query(
          `INSERT INTO conversation_segments (id, session_id, ordinal, created_at)
           VALUES ($1, $2, $3, $4)`,
          [input.segmentId ?? `${session.rows[0].id}:segment:${ordinal}`,
            session.rows[0].id, ordinal, input.createdAt],
        )
        await client.query(
          `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [session.rows[0].id, sequence, input.operationId,
            JSON.stringify(input.event), input.createdAt],
        )
        await freezeExecutionSettings(client, input.executionId, input.createdAt)
        await client.query(
          `UPDATE agent_sessions SET execution_id = $1, status = 'planning', latest_sequence = $2,
             updated_at = $3 WHERE id = $4`,
          [input.executionId, sequence, input.createdAt, session.rows[0].id],
        )
        await client.query(
          `UPDATE analyses SET status = 'queued', active = true, error = NULL, updated_at = $1
           WHERE id = $2`, [input.createdAt, input.analysisId],
        )
        await client.query('COMMIT')
        return {
          sessionId: session.rows[0].id, executionId: input.executionId,
          generation, baseReportVersion: input.baseReportVersion, created: true,
        }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async createSession(input: {
      id: string
      analysisId: string
      executionId: string
      segmentId?: string
      status: string
      operationId: string
      event: Record<string, unknown>
      createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const analysis = await client.query('SELECT id FROM analyses WHERE id = $1 FOR KEY SHARE', [input.analysisId])
        if (!analysis.rowCount) throw new Error('analysis_not_found')
        await client.query(
          `INSERT INTO agent_sessions (
             id, analysis_id, is_primary, execution_id, status, latest_sequence, created_at, updated_at
           ) VALUES ($1, $2, false, $3, $4, 1, $5, $5)`,
          [input.id, input.analysisId, input.executionId, input.status, input.createdAt],
        )
        await client.query(
          `INSERT INTO agent_events (
             session_id, sequence, operation_id, payload_json, created_at
           ) VALUES ($1, 1, $2, $3, $4)`,
          [input.id, input.operationId, JSON.stringify(input.event), input.createdAt],
        )
        const executionStatus = input.status === 'queued' ? 'planning'
          : input.status === 'running' ? 'running_model'
            : isAgentExecutionStatus(input.status) ? input.status : 'interrupted'
        const waitReason = executionStatus === 'planning'
          ? { kind: 'database', target: '研究规划', startedAt: input.createdAt }
          : executionStatus === 'running_model'
            ? { kind: 'model', target: '模型响应', startedAt: input.createdAt }
            : null
        await client.query(
          `INSERT INTO agent_executions (
             id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
           ) VALUES ($1, $2, 1, $3, $4, $5, $6, $6)`,
          [input.executionId, input.id, executionStatus,
            waitReason ? JSON.stringify(waitReason) : null,
            terminalAgentExecutionStatuses.includes(
              executionStatus as typeof terminalAgentExecutionStatuses[number],
            ),
            input.createdAt],
        )
        await client.query(
          `INSERT INTO conversation_segments (id, session_id, ordinal, created_at)
           VALUES ($1, $2, 1, $3)`,
          [input.segmentId ?? `${input.id}:segment:1`, input.id, input.createdAt],
        )
        await freezeExecutionSettings(client, input.executionId, input.createdAt)
        await client.query('COMMIT')
        return { sequence: 1, created: true, event: {
          sessionId: input.id, sequence: 1, operationId: input.operationId,
          payload: input.event, createdAt: input.createdAt,
        } }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async createSpecialistSession(input: {
      id: string; analysisId: string; domain: 'news' | 'fundamental_valuation' | 'technical'
      executionId: string; segmentId?: string; status: string; operationId: string
      event: Record<string, unknown>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const analysis = await client.query<{ active: boolean; status: string }>(
          'SELECT active, status FROM analyses WHERE id = $1 FOR UPDATE', [input.analysisId],
        )
        if (!analysis.rowCount) throw new Error('analysis_not_found')
        const replay = await client.query<AgentEventRow & { session_id: string }>(
          `SELECT e.session_id, e.sequence, e.operation_id, e.payload_json, e.created_at::text
           FROM agent_events e JOIN agent_sessions s ON s.id = e.session_id
           WHERE s.analysis_id = $1 AND s.domain = $2 AND e.operation_id = $3`,
          [input.analysisId, input.domain, input.operationId],
        )
        if (replay.rows[0]) {
          const replayExecution = await client.query<{ session_id: string }>(
            'SELECT session_id FROM agent_executions WHERE id = $1', [input.executionId],
          )
          if (replayExecution.rows[0]?.session_id !== replay.rows[0].session_id
            || !jsonValuesEqual(replay.rows[0].payload_json, input.event)
            || !sameInstant(replay.rows[0].created_at, input.createdAt)) {
            throw new Error('agent_operation_conflict')
          }
          await client.query('COMMIT')
          return {
            sessionId: replay.rows[0].session_id, executionId: input.executionId, created: false,
          }
        }
        if (!analysis.rows[0]!.active || ['stopping', 'completed', 'partial', 'failed', 'stopped',
          'interrupted', 'budget_exhausted'].includes(analysis.rows[0]!.status)) {
          throw new Error('analysis_not_active')
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO agent_sessions (
             id, analysis_id, is_primary, domain, execution_id, status,
             latest_sequence, created_at, updated_at
           ) VALUES ($1, $2, false, $3, $4, $5, 1, $6, $6)
           ON CONFLICT (analysis_id, domain) WHERE domain IS NOT NULL DO NOTHING
           RETURNING id`,
          [input.id, input.analysisId, input.domain, input.executionId, input.status, input.createdAt],
        )
        if (!inserted.rows[0]) {
          const existing = await client.query<{
            id: string; execution_id: string; latest_sequence: number
          }>(
            `SELECT id, execution_id, latest_sequence FROM agent_sessions
             WHERE analysis_id = $1 AND domain = $2 FOR UPDATE`, [input.analysisId, input.domain],
          )
          const session = existing.rows[0]!
          const replay = await client.query<AgentEventRow>(
            `SELECT session_id, sequence, operation_id, payload_json, created_at::text
             FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
            [session.id, input.operationId],
          )
          if (replay.rows[0]) {
            const replayExecution = await client.query<{ session_id: string }>(
              'SELECT session_id FROM agent_executions WHERE id = $1', [input.executionId],
            )
            if (replayExecution.rows[0]?.session_id !== session.id
              || !jsonValuesEqual(replay.rows[0].payload_json, input.event)
              || !sameInstant(replay.rows[0].created_at, input.createdAt)) {
              throw new Error('agent_operation_conflict')
            }
            await client.query('COMMIT')
            return { sessionId: session.id, executionId: input.executionId, created: false }
          }
          const current = await client.query<{ generation: number; terminal: boolean }>(
            `SELECT generation, terminal FROM agent_executions
             WHERE id = $1 FOR UPDATE`, [session.execution_id],
          )
          if (!current.rows[0]?.terminal) {
            await client.query('COMMIT')
            return { sessionId: session.id, executionId: session.execution_id, created: false }
          }
          const sequence = session.latest_sequence + 1
          const generation = current.rows[0].generation + 1
          const segment = await client.query<{ next_ordinal: number }>(
            `SELECT COALESCE(max(ordinal), 0)::integer + 1 AS next_ordinal
             FROM conversation_segments WHERE session_id = $1`, [session.id],
          )
          const ordinal = segment.rows[0]!.next_ordinal
          const waitReason = { kind: 'database', target: '专项研究规划', startedAt: input.createdAt }
          await client.query(
            `INSERT INTO agent_executions (
               id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
             ) VALUES ($1, $2, $3, 'planning', $4, false, $5, $5)`,
            [input.executionId, session.id, generation, JSON.stringify(waitReason), input.createdAt],
          )
          await client.query(
            `INSERT INTO conversation_segments (id, session_id, ordinal, created_at)
             VALUES ($1, $2, $3, $4)`,
            [input.segmentId ?? `${session.id}:segment:${ordinal}`, session.id, ordinal, input.createdAt],
          )
          await client.query(
            `INSERT INTO agent_events (
               session_id, sequence, operation_id, payload_json, created_at
             ) VALUES ($1, $2, $3, $4, $5)`,
            [session.id, sequence, input.operationId, JSON.stringify(input.event), input.createdAt],
          )
          await freezeExecutionSettings(client, input.executionId, input.createdAt)
          await client.query(
            `UPDATE agent_sessions SET execution_id = $1, status = 'planning',
               latest_sequence = $2, updated_at = $3 WHERE id = $4`,
            [input.executionId, sequence, input.createdAt, session.id],
          )
          await client.query('COMMIT')
          return { sessionId: session.id, executionId: input.executionId, created: true }
        }
        await client.query(
          `INSERT INTO agent_events (
             session_id, sequence, operation_id, payload_json, created_at
           ) VALUES ($1, 1, $2, $3, $4)`,
          [input.id, input.operationId, JSON.stringify(input.event), input.createdAt],
        )
        const waitReason = { kind: 'database', target: '专项研究规划', startedAt: input.createdAt }
        await client.query(
          `INSERT INTO agent_executions (
             id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
           ) VALUES ($1, $2, 1, 'planning', $3, false, $4, $4)`,
          [input.executionId, input.id, JSON.stringify(waitReason), input.createdAt],
        )
        await client.query(
          `INSERT INTO conversation_segments (id, session_id, ordinal, created_at)
           VALUES ($1, $2, 1, $3)`,
          [input.segmentId ?? `${input.id}:segment:1`, input.id, input.createdAt],
        )
        await freezeExecutionSettings(client, input.executionId, input.createdAt)
        await client.query('COMMIT')
        return { sessionId: input.id, executionId: input.executionId, created: true }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async append(input: {
      sessionId: string
      executionId: string
      operationId: string
      event: Record<string, unknown>
      projection?: {
        status?: string
        executionStatus?: AgentExecutionStatus
        waitTarget?: string
        terminal?: boolean
        report?: unknown
        snapshot?: unknown
        error?: string
        facts?: Array<{ id: string } & Record<string, unknown>>
        reportVersion?: {
          id: string
          kind: 'integrated' | 'specialist'
          payloadHash: string
          report: unknown
          snapshot?: unknown
        }
      }
      createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const sessionIdentity = await client.query<{ analysis_id: string }>(
          'SELECT analysis_id FROM agent_sessions WHERE id = $1', [input.sessionId],
        )
        if (!sessionIdentity.rows[0]) throw new Error('agent_session_not_found')
        await client.query(
          'SELECT id FROM analyses WHERE id = $1 FOR UPDATE',
          [sessionIdentity.rows[0].analysis_id],
        )
        const session = await client.query<{
          latest_sequence: number; analysis_id: string; is_primary: boolean; execution_id: string
        }>(
          'SELECT latest_sequence, analysis_id, is_primary, execution_id FROM agent_sessions WHERE id = $1 FOR UPDATE',
          [input.sessionId],
        )
        if (!session.rows[0]) throw new Error('agent_session_not_found')
        if (session.rows[0].execution_id !== input.executionId) throw new Error('agent_execution_fenced')
        const existing = await client.query<{ sequence: number }>(
          `SELECT sequence FROM agent_events
           WHERE session_id = $1 AND operation_id = $2`,
          [input.sessionId, input.operationId],
        )
        if (existing.rows[0]) {
          const event = await client.query<AgentEventRow>(
            `SELECT session_id, sequence, operation_id, payload_json, created_at::text
             FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
            [input.sessionId, input.operationId],
          )
          await client.query('COMMIT')
          return { sequence: existing.rows[0].sequence, created: false, event: mapAgentEventRow(event.rows[0]!) }
        }
        const execution = await client.query<{ id: string; status: string; terminal: boolean }>(
          `SELECT id, status, terminal FROM agent_executions WHERE id = $1 FOR UPDATE`,
          [input.executionId],
        )
        if (!execution.rows[0]) throw new Error('agent_execution_not_found')
        const current = execution.rows[0]
        if (current.terminal) throw new Error('agent_execution_terminal')
        if (current.status === 'stopping' && input.projection?.executionStatus !== 'stopped') {
          throw new Error('agent_execution_stopping')
        }
        let cancelledToolEvents: AgentEvent[] = []
        let sequence = session.rows[0].latest_sequence + 1
        if (input.projection?.executionStatus
          && (input.projection.terminal ?? input.event.terminal === true)) {
          const cancelled = await cancelRunningToolBatches(
            client, input.sessionId, current.id, session.rows[0].latest_sequence, input.createdAt,
          )
          cancelledToolEvents = cancelled.events
          sequence = cancelled.latestSequence + 1
          await finalizeRunningModelRequests(
            client, current.id, 'outcome_unknown', input.createdAt,
          )
        }
        await client.query(
          `INSERT INTO agent_events (
             session_id, sequence, operation_id, payload_json, created_at
           ) VALUES ($1, $2, $3, $4, $5)`,
          [input.sessionId, sequence, input.operationId, JSON.stringify(input.event), input.createdAt],
        )
        if (input.projection?.reportVersion) {
          const reportVersion = input.projection.reportVersion
          const nextVersion = await client.query<{ version: number }>(
            `SELECT COALESCE(max(version), 0)::integer + 1 AS version
             FROM report_versions WHERE session_id = $1`,
            [input.sessionId],
          )
          await client.query(
            `INSERT INTO report_versions (
               id, analysis_id, session_id, execution_id, version,
               kind, payload_hash, report_json, snapshot_json, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [reportVersion.id, session.rows[0].analysis_id, input.sessionId, input.executionId,
              nextVersion.rows[0]!.version, reportVersion.kind, reportVersion.payloadHash,
              JSON.stringify(reportVersion.report),
              reportVersion.snapshot === undefined ? null : JSON.stringify(reportVersion.snapshot),
              input.createdAt],
          )
        }
        if (input.projection?.executionStatus) {
          const waitReason = input.event.waitReason ?? null
          const terminal = input.projection.terminal
            ?? input.event.terminal === true
          await client.query(
            `UPDATE agent_executions SET status = $1, wait_reason_json = $2,
               terminal = $3, updated_at = $4 WHERE id = $5`,
            [input.projection.executionStatus, waitReason ? JSON.stringify(waitReason) : null,
              terminal, input.createdAt, current.id],
          )
        }
        for (const fact of input.projection?.facts ?? []) {
          await client.query(
            `INSERT INTO atomic_facts (id, payload_json, is_public) VALUES ($1, $2, true)
             ON CONFLICT (id) DO NOTHING`,
            [fact.id, JSON.stringify(fact)],
          )
          await client.query(
            `INSERT INTO analysis_facts (analysis_id, fact_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [session.rows[0].analysis_id, fact.id],
          )
        }
        await client.query(
          `UPDATE agent_sessions SET latest_sequence = $1,
             status = COALESCE($2, status), updated_at = $3 WHERE id = $4`,
          [sequence, input.projection?.status ?? null, input.createdAt, input.sessionId],
        )
        if (input.projection && session.rows[0].is_primary) {
          await client.query(
          `UPDATE analyses SET status = COALESCE($1, status),
               active = CASE WHEN $6::boolean IS NULL THEN active ELSE NOT $6 END,
               updated_at = $2,
               report_json = COALESCE($3::jsonb, report_json),
               report_created_at = CASE WHEN $3::jsonb IS NULL THEN report_created_at ELSE $2 END,
               snapshot_json = COALESCE($4::jsonb, snapshot_json),
               error = COALESCE($5, error) WHERE id = $7`,
            [input.projection.status, input.createdAt,
              input.projection.report ? JSON.stringify(input.projection.report) : null,
              input.projection.snapshot ? JSON.stringify(input.projection.snapshot) : null,
              input.projection.error ?? null, input.projection.terminal ?? null,
              session.rows[0].analysis_id],
          )
        }
        await client.query('COMMIT')
        return { sequence, created: true, cancelledToolEvents, event: {
          sessionId: input.sessionId, sequence, operationId: input.operationId,
          payload: input.event, createdAt: input.createdAt,
        } }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async listReportVersions(analysisId: string) {
      const result = await pool.query<{
        id: string; analysis_id: string; session_id: string; execution_id: string
        version: number; kind: 'integrated' | 'specialist'; payload_hash: string
        report_json: unknown; snapshot_json: unknown; created_at: string
      }>(
        `SELECT id, analysis_id, session_id, execution_id, version, kind,
                payload_hash, report_json, snapshot_json, created_at::text
         FROM report_versions WHERE analysis_id = $1 ORDER BY created_at, id`,
        [analysisId],
      )
      return result.rows.map((row) => ({
        id: row.id, analysisId: row.analysis_id, sessionId: row.session_id,
        executionId: row.execution_id, version: row.version, kind: row.kind,
        payloadHash: row.payload_hash, report: row.report_json,
        ...(row.snapshot_json === null ? {} : { snapshot: row.snapshot_json }),
        createdAt: new Date(row.created_at).toISOString(),
      }))
    },
    async commitCompaction(input: {
      id: string; executionId: string; segmentId: string
      operationId: string; event: Record<string, unknown>
      contextTokens: number; contextWindow: number; reserveTokens: number
      keepRecentTokens: number; tokensAfter: number; summary: Record<string, unknown>
      usage: Record<string, unknown>; attempts: Array<{
        attempt: number; status: 'completed' | 'failed' | 'cancelled'
        durationMs: number; usage: unknown
      }>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const identity = await client.query<{ analysis_id: string; session_id: string }>(
          `SELECT session.analysis_id, session.id AS session_id
           FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1`, [input.executionId],
        )
        if (!identity.rows[0]) throw new Error('agent_session_not_found')
        await client.query(
          'SELECT id FROM analyses WHERE id = $1 FOR UPDATE', [identity.rows[0].analysis_id],
        )
        const session = await client.query<{
          execution_id: string; latest_sequence: number
        }>(
          `SELECT execution_id, latest_sequence FROM agent_sessions
           WHERE id = $1 FOR UPDATE`, [identity.rows[0].session_id],
        )
        if (session.rows[0]?.execution_id !== input.executionId) {
          throw new Error('agent_execution_fenced')
        }
        const execution = await client.query<{ terminal: boolean }>(
          'SELECT terminal FROM agent_executions WHERE id = $1 FOR UPDATE', [input.executionId],
        )
        if (!execution.rows[0] || execution.rows[0].terminal) throw new Error('agent_execution_fenced')
        const replay = await client.query<AgentEventRow>(
          `SELECT session_id, sequence, operation_id, payload_json, created_at::text
           FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
          [identity.rows[0].session_id, input.operationId],
        )
        if (replay.rows[0]) {
          const compacted = await client.query<{
            id: string; from_segment_id: string; to_segment_id: string
            parent_segment_id: string | null
            context_tokens: number; context_window: number; reserve_tokens: number
            keep_recent_tokens: number; tokens_after: number
            summary_json: Record<string, unknown>; usage_json: Record<string, unknown>; created_at: string
          }>(
            `SELECT compaction.id, compaction.from_segment_id, compaction.to_segment_id,
                    target.parent_segment_id,
                    compaction.context_tokens, compaction.context_window,
                    compaction.reserve_tokens, compaction.keep_recent_tokens,
                    compaction.tokens_after, compaction.summary_json,
                    compaction.usage_json, compaction.created_at::text
             FROM agent_compactions compaction
             JOIN conversation_segments target ON target.id = compaction.to_segment_id
             WHERE compaction.id = $1`, [input.id],
          )
          const attempts = await client.query<{
            attempt: number; status: string; duration_ms: number; usage_json: unknown
          }>(
            `SELECT attempt, status, duration_ms, usage_json
             FROM agent_compaction_attempts WHERE compaction_id = $1 ORDER BY attempt`, [input.id],
          )
          if (!compacted.rows[0] || compacted.rows[0].to_segment_id !== input.segmentId
            || compacted.rows[0].parent_segment_id !== compacted.rows[0].from_segment_id
            || compacted.rows[0].context_tokens !== input.contextTokens
            || compacted.rows[0].context_window !== input.contextWindow
            || compacted.rows[0].reserve_tokens !== input.reserveTokens
            || compacted.rows[0].keep_recent_tokens !== input.keepRecentTokens
            || compacted.rows[0].tokens_after !== input.tokensAfter
            || !jsonValuesEqual(compacted.rows[0].summary_json, input.summary)
            || !jsonValuesEqual(compacted.rows[0].usage_json, input.usage)
            || !jsonValuesEqual(attempts.rows.map((attempt) => ({
              attempt: attempt.attempt, status: attempt.status,
              durationMs: attempt.duration_ms, usage: attempt.usage_json,
            })), input.attempts)
            || !jsonValuesEqual(replay.rows[0].payload_json, input.event)
            || !sameInstant(compacted.rows[0].created_at, input.createdAt)) {
            throw new Error('agent_operation_conflict')
          }
          await client.query('COMMIT')
          return { created: false, event: mapAgentEventRow(replay.rows[0]), segmentId: input.segmentId }
        }
        const currentSegment = await client.query<{ id: string; ordinal: number }>(
          `SELECT id, ordinal FROM conversation_segments WHERE session_id = $1
           ORDER BY ordinal DESC LIMIT 1`, [identity.rows[0].session_id],
        )
        if (!currentSegment.rows[0]) throw new Error('conversation_segment_not_found')
        const sequence = session.rows[0].latest_sequence + 1
        await client.query(
          `INSERT INTO conversation_segments (
             id, session_id, ordinal, parent_segment_id, created_at
           ) VALUES ($1, $2, $3, $4, $5)`,
          [input.segmentId, identity.rows[0].session_id, currentSegment.rows[0].ordinal + 1,
            currentSegment.rows[0].id, input.createdAt],
        )
        await client.query(
          `INSERT INTO agent_compactions (
             id, session_id, execution_id, from_segment_id, to_segment_id,
             context_tokens, context_window, reserve_tokens, keep_recent_tokens,
             tokens_after, summary_json, usage_json, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [input.id, identity.rows[0].session_id, input.executionId, currentSegment.rows[0].id,
            input.segmentId, input.contextTokens, input.contextWindow, input.reserveTokens,
            input.keepRecentTokens, input.tokensAfter, JSON.stringify(input.summary),
            JSON.stringify(input.usage), input.createdAt],
        )
        await insertCompactionAttempts(
          client, input.id, identity.rows[0].session_id, input.executionId,
          input.attempts, input.createdAt,
        )
        await client.query(
          `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [identity.rows[0].session_id, sequence, input.operationId,
            JSON.stringify(input.event), input.createdAt],
        )
        await client.query(
          `UPDATE agent_sessions SET latest_sequence = $1, updated_at = $2 WHERE id = $3`,
          [sequence, input.createdAt, identity.rows[0].session_id],
        )
        await client.query('COMMIT')
        return {
          created: true, segmentId: input.segmentId,
          event: {
            sessionId: identity.rows[0].session_id, sequence, operationId: input.operationId,
            payload: input.event, createdAt: input.createdAt,
          },
        }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async failCompaction(input: {
      id: string; executionId: string; operationId: string
      event: Record<string, unknown>; attempts: Array<{
        attempt: number; status: 'failed' | 'cancelled'; durationMs: number; usage: unknown
      }>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const identity = await client.query<{ session_id: string }>(
          `SELECT session.id AS session_id FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1`, [input.executionId],
        )
        if (!identity.rows[0]) throw new Error('agent_execution_fenced')
        await assertCurrentExecution(client, input.executionId)
        const sessionId = identity.rows[0].session_id
        const session = await client.query<{ latest_sequence: number }>(
          'SELECT latest_sequence FROM agent_sessions WHERE id = $1 FOR UPDATE',
          [sessionId],
        )
        const replay = await client.query<AgentEventRow>(
          `SELECT session_id, sequence, operation_id, payload_json, created_at::text
           FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
          [sessionId, input.operationId],
        )
        if (replay.rows[0]) {
          const attempts = await client.query<{
            attempt: number; status: string; duration_ms: number; usage_json: unknown
          }>(
            `SELECT attempt, status, duration_ms, usage_json
             FROM agent_compaction_attempts WHERE compaction_id = $1 ORDER BY attempt`, [input.id],
          )
          if (!jsonValuesEqual(replay.rows[0].payload_json, input.event)
            || !sameInstant(replay.rows[0].created_at, input.createdAt)) {
            throw new Error('agent_operation_conflict')
          }
          if (!jsonValuesEqual(attempts.rows.map((attempt) => ({
            attempt: attempt.attempt, status: attempt.status,
            durationMs: attempt.duration_ms, usage: attempt.usage_json,
          })), input.attempts)) throw new Error('agent_operation_conflict')
          await client.query('COMMIT')
          return { created: false, event: mapAgentEventRow(replay.rows[0]) }
        }
        await insertCompactionAttempts(
          client, input.id, sessionId, input.executionId, input.attempts, input.createdAt,
        )
        const sequence = session.rows[0]!.latest_sequence + 1
        await client.query(
          `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [sessionId, sequence, input.operationId, JSON.stringify(input.event), input.createdAt],
        )
        await client.query(
          `UPDATE agent_sessions SET latest_sequence = $1, updated_at = $2 WHERE id = $3`,
          [sequence, input.createdAt, sessionId],
        )
        await client.query('COMMIT')
        return { created: true, event: {
          sessionId, sequence, operationId: input.operationId,
          payload: input.event, createdAt: input.createdAt,
        } }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async recordCompactionAttempt(input: {
      id: string; executionId: string; attempt: number
      status: 'failed' | 'cancelled'; durationMs: number; usage: unknown; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const identity = await client.query<{ session_id: string }>(
          `SELECT session.id AS session_id FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1`, [input.executionId],
        )
        if (!identity.rows[0]) throw new Error('agent_execution_fenced')
        await assertCurrentExecution(client, input.executionId)
        await insertCompactionAttempts(
          client, input.id, identity.rows[0].session_id, input.executionId, [{
            attempt: input.attempt, status: input.status,
            durationMs: input.durationMs, usage: input.usage,
          }], input.createdAt, true,
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async interruptActiveSessions(createdAt: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const sessions = await client.query<{
          id: string; execution_id: string; analysis_id: string; is_primary: boolean; latest_sequence: number
        }>(
          `SELECT session.id, execution.id AS execution_id, session.analysis_id,
                  session.is_primary, session.latest_sequence
           FROM agent_sessions session
           JOIN agent_executions execution ON execution.session_id = session.id
           WHERE execution.terminal = false
           ORDER BY session.id FOR UPDATE OF session, execution`,
        )
        const interrupted: Array<AgentEvent & { cancelledToolEvents: AgentEvent[] }> = []
        for (const session of sessions.rows) {
          const cancelled = await cancelRunningToolBatches(
            client, session.id, session.execution_id, session.latest_sequence, createdAt,
          )
          await finalizeRunningModelRequests(
            client, session.execution_id, 'outcome_unknown', createdAt,
          )
          const sequence = cancelled.latestSequence + 1
          const operationId = `startup:interrupt:${session.id}:${sequence}`
          const payload = {
            type: 'status', status: 'interrupted', terminal: true,
            previousExecutionId: session.execution_id, at: createdAt,
          }
          await client.query(
            `INSERT INTO agent_events (
               session_id, sequence, operation_id, payload_json, created_at
             ) VALUES ($1, $2, $3, $4, $5)`,
            [session.id, sequence, operationId, JSON.stringify(payload), createdAt],
          )
          await client.query(
            `UPDATE agent_sessions SET status = 'interrupted', latest_sequence = $1, updated_at = $2
             WHERE id = $3`,
            [sequence, createdAt, session.id],
          )
          await client.query(
            `UPDATE agent_executions
             SET status = 'interrupted', wait_reason_json = NULL, terminal = true, updated_at = $1
             WHERE session_id = $2 AND terminal = false`,
            [createdAt, session.id],
          )
          if (session.is_primary) {
            await client.query(
              `UPDATE analyses SET status = 'interrupted', active = false, updated_at = $1 WHERE id = $2`,
              [createdAt, session.analysis_id],
            )
          }
          interrupted.push({
            sessionId: session.id, sequence, operationId, payload, createdAt,
            cancelledToolEvents: cancelled.events,
          })
        }
        await client.query('COMMIT')
        return interrupted
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async list(sessionId: string, afterSequence: number): Promise<AgentEvent[]> {
      const result = await pool.query<AgentEventRow>(
        `SELECT session_id, sequence, operation_id, payload_json, created_at::text
         FROM agent_events WHERE session_id = $1 AND sequence > $2 ORDER BY sequence`,
        [sessionId, afterSequence],
      )
      return result.rows.map(mapAgentEventRow)
    },
    async listByTypes(sessionId: string, types: string[]): Promise<AgentEvent[]> {
      if (!types.length) return []
      const result = await pool.query<AgentEventRow>(
        `SELECT session_id, sequence, operation_id, payload_json, created_at::text
         FROM agent_events
         WHERE session_id = $1 AND payload_json->>'type' = ANY($2::text[])
         ORDER BY sequence`,
        [sessionId, types],
      )
      return result.rows.map(mapAgentEventRow)
    },
    async listByExecution(executionId: string, afterSequence: number): Promise<AgentEvent[]> {
      const result = await pool.query<AgentEventRow>(
        `SELECT event.session_id, event.sequence, event.operation_id, event.payload_json,
           event.created_at::text FROM agent_events event
         JOIN agent_executions execution ON execution.session_id = event.session_id
         WHERE execution.id = $1 AND event.sequence > $2 ORDER BY event.sequence`,
        [executionId, afterSequence],
      )
      return result.rows.map(mapAgentEventRow)
    },
    async getSession(id: string): Promise<AgentSession | null> {
      const result = await pool.query<AgentSessionRow>(
        `SELECT id, analysis_id, is_primary, execution_id, status, latest_sequence, created_at::text, updated_at::text
         FROM agent_sessions WHERE id = $1`,
        [id],
      )
      return result.rows[0] ? mapAgentSessionRow(result.rows[0]) : null
    },
    async findPrimarySession(analysisId: string): Promise<AgentSession | null> {
      const result = await pool.query<AgentSessionRow>(
        `SELECT id, analysis_id, is_primary, execution_id, status, latest_sequence, created_at::text, updated_at::text
         FROM agent_sessions WHERE analysis_id = $1 AND is_primary`,
        [analysisId],
      )
      return result.rows[0] ? mapAgentSessionRow(result.rows[0]) : null
    },
    async listSessions(analysisId: string): Promise<AgentSession[]> {
      const result = await pool.query<AgentSessionRow>(
        `SELECT id, analysis_id, is_primary, execution_id, status, latest_sequence, created_at::text, updated_at::text
         FROM agent_sessions WHERE analysis_id = $1 ORDER BY is_primary DESC, created_at, id`,
        [analysisId],
      )
      return result.rows.map(mapAgentSessionRow)
    },
    async sessionLifecycle(sessionId: string) {
      return readSessionLifecycle(pool, sessionId)
    },
    async primaryLifecycle(analysisId: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        const sessionResult = await client.query<AgentSessionRow>(
          `SELECT id, analysis_id, is_primary, execution_id, status, latest_sequence,
             created_at::text, updated_at::text
           FROM agent_sessions WHERE analysis_id = $1 AND is_primary`,
          [analysisId],
        )
        const sessionRow = sessionResult.rows[0]
        if (!sessionRow) { await client.query('COMMIT'); return null }
        const session = mapAgentSessionRow(sessionRow)
        const execution = await client.query<{
          id: string; generation: number; status: string; terminal: boolean
          wait_reason_json: Record<string, unknown> | null
          created_at: string; updated_at: string
        }>(
          `SELECT id, generation, status, terminal, wait_reason_json, created_at::text, updated_at::text
           FROM agent_executions WHERE session_id = $1 ORDER BY generation DESC LIMIT 1`,
          [session.id],
        )
        const segments = await client.query<{
          id: string; ordinal: number; parent_segment_id: string | null; created_at: string
        }>(
          `SELECT id, ordinal, parent_segment_id, created_at::text FROM conversation_segments
           WHERE session_id = $1 ORDER BY ordinal`, [session.id],
        )
        const eventRows = await client.query<AgentEventRow>(
          `SELECT session_id, sequence, operation_id, payload_json, created_at::text
           FROM agent_events WHERE session_id = $1 ORDER BY sequence`, [session.id],
        )
        const compactions = await readCompactions(client, session.id)
        const compactionAttempts = await readCompactionAttempts(client, session.id)
        const { modelAttempts, tokenUsage } = await readModelUsage(client, session.id)
        const current = execution.rows[0]
        if (!current) { await client.query('COMMIT'); return null }
        const lifecycle = {
          ...session, status: current.status, waitReason: current.wait_reason_json,
          execution: {
            id: current.id, generation: current.generation, status: current.status,
            terminal: current.terminal,
            createdAt: new Date(current.created_at).toISOString(),
            updatedAt: new Date(current.updated_at).toISOString(),
          },
        segments: segments.rows.map((segment) => ({
          id: segment.id, ordinal: segment.ordinal,
          parentSegmentId: segment.parent_segment_id,
          createdAt: new Date(segment.created_at).toISOString(),
          })),
          events: eventRows.rows.map(mapAgentEventRow).map((event) => ({
            sequence: event.sequence, createdAt: event.createdAt, ...event.payload,
          })),
          compactions,
          compactionAttempts,
          modelAttempts,
          tokenUsage,
        }
        await client.query('COMMIT')
        return lifecycle
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}

export type AgentEventRepository = ReturnType<typeof createAgentEventRepository>

async function insertCompactionAttempts(
  client: PoolClient, compactionId: string, sessionId: string, executionId: string,
  attempts: Array<{
    attempt: number; status: 'completed' | 'failed' | 'cancelled'
    durationMs: number; usage: unknown
  }>, createdAt: string, compareCreatedAt = false,
) {
  for (const attempt of attempts) {
    const existing = await client.query<{
      session_id: string; execution_id: string; status: string; duration_ms: number
      usage_json: unknown; created_at: string
    }>(
      `SELECT session_id, execution_id, status, duration_ms, usage_json, created_at::text
       FROM agent_compaction_attempts WHERE compaction_id = $1 AND attempt = $2`,
      [compactionId, attempt.attempt],
    )
    if (existing.rows[0]) {
      const row = existing.rows[0]
      if (row.session_id !== sessionId || row.execution_id !== executionId
        || row.status !== attempt.status || row.duration_ms !== attempt.durationMs
        || !jsonValuesEqual(row.usage_json, attempt.usage)
        || (compareCreatedAt && !sameInstant(row.created_at, createdAt))) {
        throw new Error('agent_operation_conflict')
      }
      continue
    }
    await client.query(
      `INSERT INTO agent_compaction_attempts (
         compaction_id, session_id, execution_id, attempt, status, duration_ms, usage_json, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [compactionId, sessionId, executionId, attempt.attempt, attempt.status,
        attempt.durationMs, attempt.usage == null ? null : JSON.stringify(attempt.usage), createdAt],
    )
  }
}

async function readCompactions(client: PoolClient, sessionId: string) {
  const result = await client.query<{
    id: string; from_segment_id: string; to_segment_id: string
    summary_json: Record<string, unknown>; usage_json: Record<string, unknown>
    created_at: string
  }>(
    `SELECT id, from_segment_id, to_segment_id, summary_json, usage_json, created_at::text
     FROM agent_compactions WHERE session_id = $1 ORDER BY created_at, id`, [sessionId],
  )
  const attempts = await client.query<{
    compaction_id: string; attempt: number; status: string; duration_ms: number
    usage_json: Record<string, unknown> | null
  }>(
    `SELECT compaction_id, attempt, status, duration_ms, usage_json
     FROM agent_compaction_attempts WHERE session_id = $1
     ORDER BY created_at, compaction_id, attempt`, [sessionId],
  )
  return result.rows.map((compaction) => ({
    id: compaction.id, fromSegmentId: compaction.from_segment_id,
    toSegmentId: compaction.to_segment_id, summary: compaction.summary_json,
    usage: compaction.usage_json,
    attempts: attempts.rows.filter(({ compaction_id }) => compaction_id === compaction.id)
      .map((attempt) => ({
        attempt: attempt.attempt, status: attempt.status,
        durationMs: attempt.duration_ms, usage: attempt.usage_json,
      })),
    createdAt: new Date(compaction.created_at).toISOString(),
  }))
}

async function readCompactionAttempts(client: PoolClient, sessionId: string) {
  const result = await client.query<{
    compaction_id: string; attempt: number; status: string; duration_ms: number
    usage_json: Record<string, unknown> | null; created_at: string
  }>(
    `SELECT compaction_id, attempt, status, duration_ms, usage_json, created_at::text
     FROM agent_compaction_attempts WHERE session_id = $1
     ORDER BY created_at, compaction_id, attempt`, [sessionId],
  )
  return result.rows.map((attempt) => ({
    compactionId: attempt.compaction_id, attempt: attempt.attempt, status: attempt.status,
    durationMs: attempt.duration_ms, usage: attempt.usage_json,
    createdAt: new Date(attempt.created_at).toISOString(),
  }))
}

async function readModelUsage(client: PoolClient, sessionId: string) {
  const result = await client.query<{
    id: string; execution_id: string; turn_index: number; kind: string; status: string
    usage_status: string; input_tokens: number | null; cache_read_tokens: number | null
    cache_write_tokens: number | null; output_tokens: number | null; total_tokens: number | null
    created_at: string; completed_at: string | null
  }>(
    `SELECT request.id, request.execution_id, request.turn_index, request.kind, request.status,
       request.usage_status, request.input_tokens, request.cache_read_tokens,
       request.cache_write_tokens, request.output_tokens, request.total_tokens,
       request.created_at::text, request.completed_at::text
     FROM model_requests request
     JOIN agent_executions execution ON execution.id = request.execution_id
     WHERE execution.session_id = $1
     ORDER BY request.created_at, request.id`,
    [sessionId],
  )
  const modelAttempts = result.rows.map((row) => ({
    id: row.id, executionId: row.execution_id, kind: row.kind, turnIndex: row.turn_index,
    status: row.status, usageStatus: row.usage_status,
    usage: {
      input: row.input_tokens, cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens, output: row.output_tokens, total: row.total_tokens,
    },
    durationMs: row.completed_at === null
      ? null : Math.max(0, Date.parse(row.completed_at) - Date.parse(row.created_at)),
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  }))
  return {
    modelAttempts,
    tokenUsage: aggregateModelTokenUsage(modelAttempts),
  }
}

async function readSessionLifecycle(pool: Pool, sessionId: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const sessionResult = await client.query<AgentSessionRow>(
      `SELECT id, analysis_id, is_primary, execution_id, status, latest_sequence,
              created_at::text, updated_at::text
       FROM agent_sessions WHERE id = $1`, [sessionId],
    )
    const sessionRow = sessionResult.rows[0]
    if (!sessionRow) { await client.query('COMMIT'); return null }
    const session = mapAgentSessionRow(sessionRow)
    const execution = await client.query<{
      id: string; generation: number; status: string; terminal: boolean
      wait_reason_json: Record<string, unknown> | null; created_at: string; updated_at: string
    }>(
      `SELECT id, generation, status, terminal, wait_reason_json,
              created_at::text, updated_at::text
       FROM agent_executions WHERE session_id = $1 ORDER BY generation DESC LIMIT 1`,
      [sessionId],
    )
    const segments = await client.query<{
      id: string; ordinal: number; parent_segment_id: string | null; created_at: string
    }>(
      `SELECT id, ordinal, parent_segment_id, created_at::text FROM conversation_segments
       WHERE session_id = $1 ORDER BY ordinal`, [sessionId],
    )
    const eventRows = await client.query<AgentEventRow>(
      `SELECT session_id, sequence, operation_id, payload_json, created_at::text
       FROM agent_events WHERE session_id = $1 ORDER BY sequence`, [sessionId],
    )
    const compactions = await readCompactions(client, sessionId)
    const compactionAttempts = await readCompactionAttempts(client, sessionId)
    const { modelAttempts, tokenUsage } = await readModelUsage(client, sessionId)
    const current = execution.rows[0]
    if (!current) { await client.query('COMMIT'); return null }
    const lifecycle = {
      ...session, status: current.status, waitReason: current.wait_reason_json,
      execution: {
        id: current.id, generation: current.generation, status: current.status,
        terminal: current.terminal, createdAt: new Date(current.created_at).toISOString(),
        updatedAt: new Date(current.updated_at).toISOString(),
      },
      segments: segments.rows.map((segment) => ({
        id: segment.id, ordinal: segment.ordinal,
        parentSegmentId: segment.parent_segment_id,
        createdAt: new Date(segment.created_at).toISOString(),
      })),
      events: eventRows.rows.map(mapAgentEventRow).map((event) => ({
        sequence: event.sequence, createdAt: event.createdAt, ...event.payload,
      })),
      compactions,
      compactionAttempts,
      modelAttempts,
      tokenUsage,
    }
    await client.query('COMMIT')
    return lifecycle
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

type ToolProjectionRow = {
  id: string; execution_id: string; version: number; role: string; stage: string
  schema_hash: string; projected_tools_json: unknown[]
  visible_tool_names_json: string[]; reasons_json: Record<string, unknown>
  created_at: string
}

export type ToolProjectionRole = 'main' | 'fundamental' | 'news' | 'technical'

export type ToolProjectionStage = 'research' | 'finalization'

export function createToolProjectionRepository(pool: Pool) {
  return {
    async ensureVersion(input: {
      executionId: string; role: ToolProjectionRole; stage: ToolProjectionStage; schemaHash: string
      projectedTools: unknown[]; visibleToolNames: string[]
      reasons: Record<string, unknown>; createdAt: string
      causativeEvent?: { operationId: string; payload: Record<string, unknown> }
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await assertCurrentExecution(client, input.executionId)
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.executionId])
        const running = await client.query(
          `SELECT batch.id FROM tool_call_batches batch
           JOIN tool_projection_versions projection ON projection.id = batch.projection_id
           WHERE batch.execution_id = $1 AND projection.role = $2 AND batch.status = 'running' LIMIT 1`,
          [input.executionId, input.role],
        )
        if (running.rowCount) throw new Error('tool_batch_not_terminal')
        let causativeAgentEvent: AgentEvent | undefined
        if (input.causativeEvent) {
          const session = await client.query<{ id: string; latest_sequence: number }>(
            `SELECT session.id, session.latest_sequence FROM agent_executions execution
             JOIN agent_sessions session ON session.id = execution.session_id
             WHERE execution.id = $1 FOR UPDATE OF session`, [input.executionId],
          )
          if (!session.rows[0]) throw new Error('agent_session_not_found')
          const existingEvent = await client.query<AgentEventRow>(
            `SELECT session_id, sequence, operation_id, payload_json, created_at::text
             FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
            [session.rows[0].id, input.causativeEvent.operationId],
          )
          if (existingEvent.rows[0]) {
            if (!jsonValuesEqual(existingEvent.rows[0].payload_json, input.causativeEvent.payload)) {
              throw new Error('tool_projection_causative_event_conflict')
            }
          } else {
            const sequence = session.rows[0].latest_sequence + 1
            const insertedEvent = await client.query<AgentEventRow>(
              `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING session_id, sequence, operation_id, payload_json, created_at::text`,
              [session.rows[0].id, sequence, input.causativeEvent.operationId,
                JSON.stringify(input.causativeEvent.payload), input.createdAt],
            )
            await client.query(
              'UPDATE agent_sessions SET latest_sequence = $1, updated_at = $2 WHERE id = $3',
              [sequence, input.createdAt, session.rows[0].id],
            )
            causativeAgentEvent = mapAgentEventRow(insertedEvent.rows[0]!)
          }
        }
        const existing = await client.query<ToolProjectionRow>(
          `SELECT id, execution_id, version, role, stage, schema_hash, projected_tools_json, visible_tool_names_json,
             reasons_json, created_at::text FROM tool_projection_versions
           WHERE execution_id = $1 AND role = $2 AND stage = $3 AND schema_hash = $4
             AND visible_tool_names_json = $5::jsonb`,
          [input.executionId, input.role, input.stage, input.schemaHash,
            JSON.stringify(input.visibleToolNames)],
        )
        if (existing.rows[0]) {
          if (!jsonValuesEqual(existing.rows[0].projected_tools_json, input.projectedTools)
            || !jsonValuesEqual(existing.rows[0].reasons_json, input.reasons)) {
            throw new Error('tool_projection_conflict')
          }
          await client.query('COMMIT')
          return { ...mapToolProjection(existing.rows[0]), event: causativeAgentEvent }
        }
        const version = await client.query<{ next: number }>(
          `SELECT COALESCE(max(version), 0) + 1 AS next
           FROM tool_projection_versions WHERE execution_id = $1`, [input.executionId],
        )
        const next = Number(version.rows[0]!.next)
        const id = `${input.executionId}:tool-projection:${next}`
        const inserted = await client.query<ToolProjectionRow>(
          `INSERT INTO tool_projection_versions (
             id, execution_id, version, role, stage, schema_hash, projected_tools_json,
             visible_tool_names_json, reasons_json, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, execution_id, version, role, stage, schema_hash, projected_tools_json, visible_tool_names_json,
             reasons_json, created_at::text`,
          [id, input.executionId, next, input.role, input.stage, input.schemaHash,
            JSON.stringify(input.projectedTools), JSON.stringify(input.visibleToolNames),
            JSON.stringify(input.reasons), input.createdAt],
        )
        await client.query('COMMIT')
        return { ...mapToolProjection(inserted.rows[0]!), event: causativeAgentEvent }
      } catch (error) {
        await client.query('ROLLBACK'); throw error
      } finally { client.release() }
    },
    async recordModelRequest(input: {
      id: string; executionId: string; projectionId: string; turnIndex: number
      kind?: 'turn' | 'compaction'; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await assertCurrentExecution(client, input.executionId)
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.id])
        const projection = await client.query(
          `SELECT id FROM tool_projection_versions WHERE id = $1 AND execution_id = $2`,
          [input.projectionId, input.executionId],
        )
        if (!projection.rowCount) throw new Error('tool_projection_not_available')
        const existing = await client.query<{
          execution_id: string; projection_id: string; turn_index: number
          kind: string; created_at: string
        }>(
          `SELECT execution_id, projection_id, turn_index, kind, created_at::text
           FROM model_requests WHERE id = $1`, [input.id],
        )
        if (existing.rows[0]) {
          const row = existing.rows[0]
          if (row.execution_id !== input.executionId || row.projection_id !== input.projectionId
            || row.turn_index !== input.turnIndex
            || row.kind !== (input.kind ?? 'turn')
            || new Date(row.created_at).toISOString() !== new Date(input.createdAt).toISOString()) {
            throw new Error('model_request_conflict')
          }
          await client.query('COMMIT')
          return
        }
        await client.query(
          `INSERT INTO model_requests (id, execution_id, projection_id, turn_index, kind, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [input.id, input.executionId, input.projectionId, input.turnIndex,
            input.kind ?? 'turn', input.createdAt],
        )
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    },
    async completeModelRequest(input: {
      id: string; executionId: string
      status: 'completed' | 'failed' | 'cancelled' | 'outcome_unknown'
      usageStatus: 'complete' | 'partial' | 'unknown'
      usage: {
        input: number | null; cacheRead: number | null; cacheWrite: number | null
        output: number | null; total: number | null
      }
      completedAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const identity = await client.query<{ analysis_id: string; session_id: string }>(
          `SELECT session.analysis_id, session.id AS session_id
           FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1`, [input.executionId],
        )
        if (!identity.rows[0]) throw new Error('agent_execution_fenced')
        await client.query(
          'SELECT id FROM analyses WHERE id = $1 FOR UPDATE', [identity.rows[0].analysis_id],
        )
        const execution = await client.query<{
          current_execution_id: string; terminal: boolean
        }>(
          `SELECT session.execution_id AS current_execution_id, execution.terminal
           FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1 FOR UPDATE OF session, execution`, [input.executionId],
        )
        const request = await client.query<{
          execution_id: string; status: string; usage_status: string
          input_tokens: number | null; cache_read_tokens: number | null
          cache_write_tokens: number | null; output_tokens: number | null
          total_tokens: number | null; completed_at: string | null
        }>(
          `SELECT execution_id, status, usage_status, input_tokens, cache_read_tokens,
             cache_write_tokens, output_tokens, total_tokens, completed_at::text
           FROM model_requests WHERE id = $1 FOR UPDATE`, [input.id],
        )
        const row = request.rows[0]
        if (!row || row.execution_id !== input.executionId) throw new Error('model_request_not_found')
        if (row.status !== 'started') {
          if (row.status !== input.status || row.usage_status !== input.usageStatus
            || row.input_tokens !== input.usage.input
            || row.cache_read_tokens !== input.usage.cacheRead
            || row.cache_write_tokens !== input.usage.cacheWrite
            || row.output_tokens !== input.usage.output
            || row.total_tokens !== input.usage.total
            || !sameInstant(row.completed_at, input.completedAt)) {
            throw new Error('model_request_conflict')
          }
          await client.query('COMMIT')
          return { created: false }
        }
        if (execution.rows[0]?.current_execution_id !== input.executionId
          || execution.rows[0].terminal) throw new Error('agent_execution_fenced')
        await client.query(
          `UPDATE model_requests SET status = $1, usage_status = $2,
             input_tokens = $3, cache_read_tokens = $4, cache_write_tokens = $5,
             output_tokens = $6, total_tokens = $7, completed_at = $8
           WHERE id = $9`,
          [input.status, input.usageStatus, input.usage.input, input.usage.cacheRead,
            input.usage.cacheWrite, input.usage.output, input.usage.total,
            input.completedAt, input.id],
        )
        await client.query('COMMIT')
        return { created: true }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async beginToolBatch(input: {
      id: string; executionId: string; projectionId: string; turnIndex: number
      calls: Array<{
        toolCallId: string; toolName: string; position: number
        operationId?: string; eventPayload?: Record<string, unknown>
      }>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await assertCurrentExecution(client, input.executionId)
        const session = await client.query<{ id: string; latest_sequence: number }>(
          `SELECT session.id, session.latest_sequence FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1 AND session.execution_id = execution.id AND NOT execution.terminal
           FOR UPDATE OF session, execution`, [input.executionId],
        )
        if (!session.rows[0]) throw new Error('agent_execution_fenced')
        await client.query(
          `INSERT INTO tool_call_batches (
             id, execution_id, projection_id, turn_index, status, created_at
           ) VALUES ($1, $2, $3, $4, 'running', $5)`,
          [input.id, input.executionId, input.projectionId, input.turnIndex, input.createdAt],
        )
        const projected = await client.query<{ visible_tool_names_json: string[] }>(
          `SELECT visible_tool_names_json FROM tool_projection_versions
           WHERE id = $1 AND execution_id = $2`, [input.projectionId, input.executionId],
        )
        const visibleNames = new Set(projected.rows[0]?.visible_tool_names_json ?? [])
        for (const call of input.calls) {
          if (call.toolName !== 'tool_not_available' && !visibleNames.has(call.toolName)) {
            throw new Error('tool_not_available')
          }
          await client.query(
          `INSERT INTO tool_batch_calls (batch_id, tool_call_id, tool_name, position)
           VALUES ($1, $2, $3, $4)`,
          [input.id, call.toolCallId, call.toolName, call.position],
          )
        }
        let sequence = session.rows[0].latest_sequence
        for (const call of input.calls) {
          if (!call.operationId || !call.eventPayload) continue
          sequence += 1
          await client.query(
            `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [session.rows[0].id, sequence, call.operationId,
              JSON.stringify(call.eventPayload), input.createdAt],
          )
        }
        if (sequence !== session.rows[0].latest_sequence) await client.query(
          `UPDATE agent_sessions SET latest_sequence = $1, updated_at = $2 WHERE id = $3`,
          [sequence, input.createdAt, session.rows[0].id],
        )
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    },
    async startToolCall(input: {
      batchId: string; executionId: string; toolCallId: string; startedAt: string
      operationId: string; eventPayload: Record<string, unknown>
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const sessionIdentity = await client.query<{ analysis_id: string }>(
          `SELECT session.analysis_id FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1`, [input.executionId],
        )
        if (!sessionIdentity.rows[0]) throw new Error('agent_session_not_found')
        await client.query(
          'SELECT id FROM analyses WHERE id = $1 FOR UPDATE',
          [sessionIdentity.rows[0].analysis_id],
        )
        const session = await client.query<{
          id: string; latest_sequence: number; current_execution_id: string; terminal: boolean
        }>(
          `SELECT session.id, session.latest_sequence, session.execution_id AS current_execution_id,
             execution.terminal FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1
           FOR UPDATE OF session, execution`, [input.executionId],
        )
        if (!session.rows[0]) throw new Error('agent_session_not_found')
        if (session.rows[0].current_execution_id !== input.executionId
          || session.rows[0].terminal) throw new Error('agent_execution_fenced')
        const call = await client.query<{ started_at: string | null; batch_status: string }>(
          `SELECT call.started_at::text, batch.status AS batch_status FROM tool_batch_calls call
           JOIN tool_call_batches batch ON batch.id = call.batch_id
           WHERE call.batch_id = $1 AND call.tool_call_id = $2
             AND batch.execution_id = $3
           FOR UPDATE OF call`, [input.batchId, input.toolCallId, input.executionId],
        )
        if (!call.rows[0]) throw new Error('tool_call_not_found')
        if (call.rows[0].batch_status !== 'running') throw new Error('tool_call_not_running')
        const eventPayload = { ...input.eventPayload, toolCallId: input.toolCallId }
        const existing = await client.query<AgentEventRow>(
          `SELECT session_id, sequence, operation_id, payload_json, created_at::text
           FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
          [session.rows[0].id, input.operationId],
        )
        if (call.rows[0].started_at || existing.rows[0]) {
          const row = existing.rows[0]
          if (!sameInstant(call.rows[0].started_at, input.startedAt) || !row
            || !sameInstant(row.created_at, input.startedAt)
            || !jsonValuesEqual(row.payload_json, eventPayload)) {
            throw new Error('tool_call_start_conflict')
          }
          await client.query('COMMIT')
          return mapAgentEventRow(row)
        }
        await client.query(
          `UPDATE tool_batch_calls SET started_at = $1
           WHERE batch_id = $2 AND tool_call_id = $3 AND status = 'running'`,
          [input.startedAt, input.batchId, input.toolCallId],
        )
        const sequence = session.rows[0].latest_sequence + 1
        const inserted = await client.query<AgentEventRow>(
          `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING session_id, sequence, operation_id, payload_json, created_at::text`,
          [session.rows[0].id, sequence, input.operationId,
            JSON.stringify(eventPayload), input.startedAt],
        )
        await client.query(
          `UPDATE agent_sessions SET latest_sequence = $1, updated_at = $2 WHERE id = $3`,
          [sequence, input.startedAt, session.rows[0].id],
        )
        await client.query('COMMIT')
        return mapAgentEventRow(inserted.rows[0]!)
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    },
    async completeToolBatch(input: {
      id: string; executionId: string
      results: Array<{
        toolCallId: string; status: 'completed' | 'failed' | 'cancelled'
        startedAt: string | null; completedAt: string; completionOrder: number
        resultPayload: Record<string, unknown>; operationId: string
        eventPayload: Record<string, unknown>
      }>
      completedAt: string
      advance?: {
        role: ToolProjectionRole; stage: ToolProjectionStage; schemaHash: string
        projectedTools: unknown[]; visibleToolNames: string[]; reasons: Record<string, unknown>
        toolRounds: number; activeElapsedMs: number
        causativeEvent?: { operationId: string; payload: Record<string, unknown> }
      }
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const sessionIdentity = await client.query<{ analysis_id: string }>(
          `SELECT session.analysis_id FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1`, [input.executionId],
        )
        if (!sessionIdentity.rows[0]) throw new Error('agent_session_not_found')
        await client.query(
          'SELECT id FROM analyses WHERE id = $1 FOR UPDATE',
          [sessionIdentity.rows[0].analysis_id],
        )
        const session = await client.query<{
          session_id: string; analysis_id: string; latest_sequence: number
          current_execution_id: string; execution_terminal: boolean
        }>(
          `SELECT execution.session_id, session.analysis_id, session.latest_sequence,
             session.execution_id AS current_execution_id, execution.terminal AS execution_terminal
           FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1 FOR UPDATE OF session, execution`,
          [input.executionId],
        )
        if (!session.rows[0]) throw new Error('agent_session_not_found')
        const batch = await client.query<{ status: string; completed_at: string | null }>(
          `SELECT status, completed_at::text FROM tool_call_batches
           WHERE id = $1 AND execution_id = $2 FOR UPDATE`,
          [input.id, input.executionId],
        )
        if (!batch.rows[0]) throw new Error('tool_batch_not_found')
        if (batch.rows[0].status === 'running'
          && (session.rows[0].current_execution_id !== input.executionId
            || session.rows[0].execution_terminal)) throw new Error('agent_execution_fenced')
        const expected = await client.query<{
          tool_call_id: string; status: string; started_at: string | null; completed_at: string | null
          completion_order: number | null; result_payload_json: Record<string, unknown> | null
        }>(
          `SELECT call.tool_call_id, call.status, call.started_at::text, call.completed_at::text,
             call.completion_order, call.result_payload_json
           FROM tool_batch_calls call
           WHERE call.batch_id = $1 ORDER BY call.position FOR UPDATE`,
          [input.id],
        )
        if (expected.rowCount !== input.results.length
          || new Set(input.results.map((result) => result.toolCallId)).size !== input.results.length
          || expected.rows.some((row) => !input.results.some((result) => result.toolCallId === row.tool_call_id))) {
          throw new Error('tool_batch_results_incomplete')
        }
        const orderedResults = [...input.results].sort((left, right) => left.completionOrder - right.completionOrder)
        if (orderedResults.some((result, index) => result.completionOrder !== index + 1)) {
          throw new Error('tool_batch_completion_order_invalid')
        }
        if (batch.rows[0].status !== 'running') {
          if (expected.rows.some((row) => row.result_payload_json === null || row.completion_order === null)) {
            throw new Error('agent_execution_fenced')
          }
          const expectedBatchStatus = input.results.some((result) => result.status === 'failed') ? 'failed'
            : input.results.some((result) => result.status === 'cancelled') ? 'cancelled' : 'completed'
          const callsMatch = expected.rows.every((row) => {
            const result = input.results.find((item) => item.toolCallId === row.tool_call_id)!
            return row.status === result.status
              && nullableInstantsEqual(row.started_at, result.startedAt)
              && sameInstant(row.completed_at, result.completedAt)
              && row.completion_order === result.completionOrder
              && jsonValuesEqual(row.result_payload_json, {
                ...result.resultPayload, toolCallId: result.toolCallId,
              })
          })
          if (!callsMatch || batch.rows[0].status !== expectedBatchStatus
            || !sameInstant(batch.rows[0].completed_at, input.completedAt)) {
            throw new Error('tool_batch_completion_conflict')
          }
          const existingEvents: AgentEvent[] = []
          for (const result of orderedResults) {
            const eventPayload: Record<string, unknown> = {
              ...result.eventPayload, toolCallId: result.toolCallId,
            }
            const event = await client.query<AgentEventRow>(
              `SELECT session_id, sequence, operation_id, payload_json, created_at::text
               FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
              [session.rows[0].session_id, result.operationId],
            )
            const row = event.rows[0]
            if (!row || !jsonValuesEqual(row.payload_json, eventPayload)
              || !sameInstant(row.created_at, result.completedAt)) {
              throw new Error('tool_batch_completion_conflict')
            }
            existingEvents.push(mapAgentEventRow(row))
          }
          if (input.advance) {
            const turnPayload = {
              type: 'runtime_turn_advanced', toolRounds: input.advance.toolRounds,
              activeElapsedMs: input.advance.activeElapsedMs, stage: input.advance.stage,
            }
            const advanceEvents = [
              { operationId: `${input.id}:turn-advanced`, payload: turnPayload },
              ...(input.advance.causativeEvent ? [input.advance.causativeEvent] : []),
            ]
            for (const expectedEvent of advanceEvents) {
              const event = await client.query<AgentEventRow>(
                `SELECT session_id, sequence, operation_id, payload_json, created_at::text
                 FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
                [session.rows[0].session_id, expectedEvent.operationId],
              )
              if (!event.rows[0] || !jsonValuesEqual(event.rows[0].payload_json, expectedEvent.payload)) {
                throw new Error('tool_batch_completion_conflict')
              }
              existingEvents.push(mapAgentEventRow(event.rows[0]))
            }
          }
          const projection = input.advance ? await client.query<ToolProjectionRow>(
            `SELECT id, execution_id, version, role, stage, schema_hash, projected_tools_json,
               visible_tool_names_json, reasons_json, created_at::text FROM tool_projection_versions
             WHERE execution_id = $1 AND role = $2 AND stage = $3 AND schema_hash = $4
               AND visible_tool_names_json = $5::jsonb`,
            [input.executionId, input.advance.role, input.advance.stage, input.advance.schemaHash,
              JSON.stringify(input.advance.visibleToolNames)],
          ) : undefined
          if (input.advance && (!projection?.rows[0]
            || !jsonValuesEqual(projection.rows[0].projected_tools_json, input.advance.projectedTools)
            || !jsonValuesEqual(projection.rows[0].reasons_json, input.advance.reasons))) {
            throw new Error('tool_batch_completion_conflict')
          }
          existingEvents.sort((left, right) => left.sequence - right.sequence)
          await client.query('COMMIT')
          return { events: existingEvents, projection: projection?.rows[0]
            ? mapToolProjection(projection.rows[0]) : undefined }
        }
        for (const result of orderedResults) {
          const existingCall = expected.rows.find((row) => row.tool_call_id === result.toolCallId)!
          if (!nullableInstantsEqual(existingCall.started_at, result.startedAt)) {
            throw new Error('tool_batch_started_at_conflict')
          }
          if (result.startedAt === null && result.status !== 'cancelled') {
            throw new Error('tool_batch_started_at_required')
          }
          const updated = await client.query(
          `UPDATE tool_batch_calls SET status = $1, completed_at = $2,
             completion_order = $3, result_payload_json = $4
           WHERE batch_id = $5 AND tool_call_id = $6 AND status = 'running'`,
          [result.status, result.completedAt, result.completionOrder,
            JSON.stringify({ ...result.resultPayload, toolCallId: result.toolCallId }),
            input.id, result.toolCallId],
          )
          if (!updated.rowCount) throw new Error('tool_call_not_running')
        }
        const closed = await client.query(
          `UPDATE tool_call_batches batch SET
             status = CASE
               WHEN EXISTS (SELECT 1 FROM tool_batch_calls call
                 WHERE call.batch_id = batch.id AND call.status = 'failed') THEN 'failed'
               WHEN EXISTS (SELECT 1 FROM tool_batch_calls call
                 WHERE call.batch_id = batch.id AND call.status = 'cancelled') THEN 'cancelled'
               ELSE 'completed'
             END,
             completed_at = $1
           WHERE id = $2 AND execution_id = $3 AND status = 'running'`,
          [input.completedAt, input.id, input.executionId],
        )
        if (!closed.rowCount) throw new Error('tool_batch_not_running')
        const createdEvents: AgentEvent[] = []
        let sequence = session.rows[0].latest_sequence
        for (const result of orderedResults) {
          const eventPayload: Record<string, unknown> = {
            ...result.eventPayload, toolCallId: result.toolCallId,
          }
          sequence += 1
          const inserted = await client.query<AgentEventRow>(
            `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING session_id, sequence, operation_id, payload_json, created_at::text`,
            [session.rows[0].session_id, sequence, result.operationId,
              JSON.stringify(eventPayload), result.completedAt],
          )
          createdEvents.push(mapAgentEventRow(inserted.rows[0]!))
          if (eventPayload.type === 'tool_result') {
            const facts = (eventPayload.result as { facts?: unknown[] } | undefined)?.facts ?? []
            for (const fact of facts) {
              if (!fact || typeof fact !== 'object' || typeof (fact as { id?: unknown }).id !== 'string') continue
              const id = (fact as { id: string }).id
              await client.query(
                `INSERT INTO atomic_facts (id, payload_json, is_public) VALUES ($1, $2, true)
                 ON CONFLICT (id) DO NOTHING`,
                [id, JSON.stringify(fact)],
              )
              await client.query(
                `INSERT INTO analysis_facts (analysis_id, fact_id) VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [session.rows[0].analysis_id, id],
              )
            }
          }
        }
        let advancedProjection: ReturnType<typeof mapToolProjection> | undefined
        if (input.advance) {
          sequence += 1
          const turnEvent = await client.query<AgentEventRow>(
            `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING session_id, sequence, operation_id, payload_json, created_at::text`,
            [session.rows[0].session_id, sequence, `${input.id}:turn-advanced`, JSON.stringify({
              type: 'runtime_turn_advanced', toolRounds: input.advance.toolRounds,
              activeElapsedMs: input.advance.activeElapsedMs, stage: input.advance.stage,
            }), input.completedAt],
          )
          createdEvents.push(mapAgentEventRow(turnEvent.rows[0]!))
          if (input.advance.causativeEvent) {
            sequence += 1
            const decision = await client.query<AgentEventRow>(
              `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING session_id, sequence, operation_id, payload_json, created_at::text`,
              [session.rows[0].session_id, sequence, input.advance.causativeEvent.operationId,
                JSON.stringify(input.advance.causativeEvent.payload), input.completedAt],
            )
            createdEvents.push(mapAgentEventRow(decision.rows[0]!))
          }
          const existingProjection = await client.query<ToolProjectionRow>(
            `SELECT id, execution_id, version, role, stage, schema_hash, projected_tools_json,
               visible_tool_names_json, reasons_json, created_at::text FROM tool_projection_versions
             WHERE execution_id = $1 AND role = $2 AND stage = $3 AND schema_hash = $4
               AND visible_tool_names_json = $5::jsonb`,
            [input.executionId, input.advance.role, input.advance.stage, input.advance.schemaHash,
              JSON.stringify(input.advance.visibleToolNames)],
          )
          if (existingProjection.rows[0]) {
            if (!jsonValuesEqual(existingProjection.rows[0].projected_tools_json, input.advance.projectedTools)
              || !jsonValuesEqual(existingProjection.rows[0].reasons_json, input.advance.reasons)) {
              throw new Error('tool_projection_conflict')
            }
            advancedProjection = mapToolProjection(existingProjection.rows[0])
          } else {
            const version = Number((await client.query<{ next: number }>(
              `SELECT COALESCE(max(version), 0) + 1 AS next
               FROM tool_projection_versions WHERE execution_id = $1`, [input.executionId],
            )).rows[0]!.next)
            const insertedProjection = await client.query<ToolProjectionRow>(
              `INSERT INTO tool_projection_versions (
                 id, execution_id, version, role, stage, schema_hash, projected_tools_json,
                 visible_tool_names_json, reasons_json, created_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               RETURNING id, execution_id, version, role, stage, schema_hash, projected_tools_json,
                 visible_tool_names_json, reasons_json, created_at::text`,
              [`${input.executionId}:tool-projection:${version}`, input.executionId, version,
                input.advance.role, input.advance.stage, input.advance.schemaHash,
                JSON.stringify(input.advance.projectedTools), JSON.stringify(input.advance.visibleToolNames),
                JSON.stringify(input.advance.reasons), input.completedAt],
            )
            advancedProjection = mapToolProjection(insertedProjection.rows[0]!)
          }
        }
        await client.query(
          `UPDATE agent_sessions SET latest_sequence = $1, updated_at = $2 WHERE id = $3`,
          [sequence, input.completedAt, session.rows[0].session_id],
        )
        await client.query('COMMIT')
        return { events: createdEvents, projection: advancedProjection }
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    },
    async replay(executionId: string) {
      const [projections, requests, batches, calls] = await Promise.all([
        pool.query<ToolProjectionRow>(
          `SELECT id, execution_id, version, role, stage, schema_hash, projected_tools_json, visible_tool_names_json,
             reasons_json, created_at::text FROM tool_projection_versions
           WHERE execution_id = $1 ORDER BY version`, [executionId],
        ),
        pool.query<{ id: string; projection_version: number; turn_index: number; created_at: string }>(
          `SELECT request.id, projection.version AS projection_version, request.turn_index,
             request.created_at::text FROM model_requests request
           JOIN tool_projection_versions projection ON projection.id = request.projection_id
           WHERE request.execution_id = $1
           ORDER BY request.turn_index, request.created_at, request.id`, [executionId],
        ),
        pool.query<{ id: string; projection_version: number; turn_index: number; status: string; created_at: string; completed_at: string | null }>(
          `SELECT batch.id, projection.version AS projection_version, batch.turn_index,
             batch.status, batch.created_at::text, batch.completed_at::text
           FROM tool_call_batches batch
           JOIN tool_projection_versions projection ON projection.id = batch.projection_id
           WHERE batch.execution_id = $1
           ORDER BY batch.turn_index, batch.created_at, batch.id`, [executionId],
        ),
        pool.query<{
          batch_id: string; tool_call_id: string; tool_name: string; position: number; status: string
          started_at: string | null; completed_at: string | null; completion_order: number | null
          result_payload_json: Record<string, unknown> | null
        }>(
          `SELECT call.batch_id, call.tool_call_id, call.tool_name, call.position, call.status,
             call.started_at::text, call.completed_at::text, call.completion_order,
             call.result_payload_json FROM tool_batch_calls call
           JOIN tool_call_batches batch ON batch.id = call.batch_id
           WHERE batch.execution_id = $1
           ORDER BY batch.turn_index, batch.created_at, batch.id, call.position`, [executionId],
        ),
      ])
      return {
        projections: projections.rows.map(mapToolProjection),
        modelRequests: requests.rows.map((row) => ({
          id: row.id, projectionVersion: row.projection_version, turnIndex: row.turn_index,
          createdAt: new Date(row.created_at).toISOString(),
        })),
        toolBatches: batches.rows.map((batch) => ({
          id: batch.id, projectionVersion: batch.projection_version,
          turnIndex: batch.turn_index, status: batch.status,
          calls: calls.rows.filter((call) => call.batch_id === batch.id).map((call) => ({
            toolCallId: call.tool_call_id, toolName: call.tool_name, position: call.position,
          })),
          results: calls.rows.filter((call) => call.batch_id === batch.id).map((call) => ({
            toolCallId: call.tool_call_id, status: call.status,
            startedAt: call.started_at ? new Date(call.started_at).toISOString() : null,
            completedAt: call.completed_at ? new Date(call.completed_at).toISOString() : null,
            completionOrder: call.completion_order, resultPayload: call.result_payload_json,
          })),
        })),
      }
    },
    async replayForSession(sessionId: string, executionId: string) {
      const belongs = await pool.query(
        `SELECT id FROM agent_executions WHERE id = $1 AND session_id = $2`,
        [executionId, sessionId],
      )
      if (!belongs.rowCount) return null
      return { executionId, ...await this.replay(executionId) }
    },
  }
}

export type ToolProjectionRepository = ReturnType<typeof createToolProjectionRepository>

async function cancelRunningToolBatches(
  database: PoolClient, sessionId: string, executionId: string,
  latestSequence: number, completedAt: string,
) {
  const calls = await database.query<{
    batch_id: string; tool_call_id: string; tool_name: string; position: number; started_at: string | null
    max_completion_order: number
  }>(
    `SELECT call.batch_id, call.tool_call_id, call.tool_name, call.position, call.started_at::text,
       COALESCE((SELECT max(completed.completion_order) FROM tool_batch_calls completed
         WHERE completed.batch_id = call.batch_id), 0)::integer AS max_completion_order
    FROM tool_batch_calls call
    JOIN tool_call_batches batch ON batch.id = call.batch_id
    JOIN tool_projection_versions projection ON projection.id = batch.projection_id
     WHERE batch.execution_id = $1 AND batch.status = 'running' AND call.status = 'running'
       AND (projection.visible_tool_names_json ? call.tool_name OR call.tool_name = 'tool_not_available')
     ORDER BY call.batch_id, call.position FOR UPDATE OF call`, [executionId],
  )
  const orderByBatch = new Map<string, number>()
  const events: AgentEvent[] = []
  let sequence = latestSequence
  for (const call of calls.rows) {
    const completionOrder = (orderByBatch.get(call.batch_id) ?? call.max_completion_order) + 1
    orderByBatch.set(call.batch_id, completionOrder)
    await database.query(
      `UPDATE tool_batch_calls SET status = 'cancelled', completed_at = $1,
         completion_order = $2, result_payload_json = $3
       WHERE batch_id = $4 AND tool_call_id = $5 AND status = 'running'`,
      [completedAt, completionOrder, JSON.stringify({
        toolCallId: call.tool_call_id,
        toolName: call.tool_name,
        result: { error: 'tool_execution_interrupted', facts: [] }, isError: true,
      }), call.batch_id, call.tool_call_id],
    )
    const startedAt = call.started_at
    if (startedAt === null) {
      sequence += 1
      const callOperationId = `${call.batch_id}:cancelled-call:${call.tool_call_id}`
      const callPayload = {
        type: 'tool_call', name: call.tool_name, toolCallId: call.tool_call_id,
        input: {}, startedAt: null, notStarted: true, operationId: callOperationId,
      }
      const insertedCall = await database.query<AgentEventRow>(
        `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING session_id, sequence, operation_id, payload_json, created_at::text`,
        [sessionId, sequence, callOperationId, JSON.stringify(callPayload), completedAt],
      )
      events.push(mapAgentEventRow(insertedCall.rows[0]!))
    }
    sequence += 1
    const operationId = `${call.batch_id}:cancelled-result:${call.tool_call_id}`
    const payload = {
      type: 'tool_result', name: call.tool_name,
      result: { error: 'tool_execution_interrupted', facts: [] }, isError: true,
      toolCallId: call.tool_call_id, startedAt, notStarted: startedAt === null,
      completedAt, completionOrder, operationId,
    }
    const inserted = await database.query<AgentEventRow>(
      `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING session_id, sequence, operation_id, payload_json, created_at::text`,
      [sessionId, sequence, operationId, JSON.stringify(payload), completedAt],
    )
    events.push(mapAgentEventRow(inserted.rows[0]!))
  }
  await database.query(
    `UPDATE tool_call_batches SET status = 'cancelled', completed_at = $1
     WHERE execution_id = $2 AND status = 'running'`,
    [completedAt, executionId],
  )
  return { latestSequence: sequence, events }
}

async function cancelRunningCompactionAttempts(
  database: PoolClient, sessionId: string, executionId: string, cancelledAt: string,
) {
  const requests = await database.query<{
    id: string; created_at: string; attempt: number; compaction_id: string
  }>(
    `SELECT request.id, request.created_at::text,
       (regexp_match(request.id, ':compaction:[^:]+:attempt:([12])$'))[1]::integer AS attempt,
       regexp_replace(request.id, ':attempt:[12]$', '') AS compaction_id
     FROM model_requests request
     WHERE request.execution_id = $1 AND request.id ~ ':compaction:[^:]+:attempt:[12]$'
       AND NOT EXISTS (
         SELECT 1 FROM agent_compaction_attempts attempt
         WHERE attempt.compaction_id = regexp_replace(request.id, ':attempt:[12]$', '')
           AND attempt.attempt = (regexp_match(request.id, ':compaction:[^:]+:attempt:([12])$'))[1]::integer
       )
     ORDER BY request.created_at, request.id`,
    [executionId],
  )
  for (const request of requests.rows) {
    await insertCompactionAttempts(
      database, request.compaction_id, sessionId, executionId, [{
        attempt: request.attempt, status: 'cancelled',
        durationMs: Math.max(0, Date.parse(cancelledAt) - Date.parse(request.created_at)),
        usage: null,
      }], cancelledAt,
    )
  }
}

async function finalizeRunningModelRequests(
  database: PoolClient, executionId: string,
  status: 'cancelled' | 'outcome_unknown', completedAt: string,
) {
  await database.query(
    `UPDATE model_requests SET status = $1, usage_status = 'unknown', completed_at = $2
     WHERE execution_id = $3 AND status = 'started'`,
    [status, completedAt, executionId],
  )
}

async function assertCurrentExecution(database: PoolClient, executionId: string) {
  const identity = await database.query<{ analysis_id: string }>(
    `SELECT session.analysis_id FROM agent_executions execution
     JOIN agent_sessions session ON session.id = execution.session_id
     WHERE execution.id = $1`, [executionId],
  )
  if (!identity.rows[0]) throw new Error('agent_execution_fenced')
  await database.query(
    'SELECT id FROM analyses WHERE id = $1 FOR UPDATE', [identity.rows[0].analysis_id],
  )
  const execution = await database.query(
    `SELECT execution.id FROM agent_executions execution
     JOIN agent_sessions session ON session.id = execution.session_id
     WHERE execution.id = $1 AND session.execution_id = execution.id AND NOT execution.terminal
     FOR UPDATE OF session, execution`, [executionId],
  )
  if (!execution.rowCount) throw new Error('agent_execution_fenced')
}

function mapToolProjection(row: ToolProjectionRow) {
  return {
    id: row.id, executionId: row.execution_id, version: row.version, role: row.role,
    stage: row.stage, schemaHash: row.schema_hash, projectedTools: row.projected_tools_json,
    visibleToolNames: row.visible_tool_names_json,
    reasons: row.reasons_json, createdAt: new Date(row.created_at).toISOString(),
  }
}

function mapAgentEventRow(row: AgentEventRow): AgentEvent {
  return {
    sessionId: row.session_id,
    sequence: row.sequence,
    operationId: row.operation_id,
    payload: row.payload_json,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function isAgentExecutionStatus(value: string): value is AgentExecutionStatus {
  return agentExecutionStatuses.includes(value as AgentExecutionStatus)
}

function mapAgentSessionRow(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    analysisId: row.analysis_id,
    status: row.status,
    isPrimary: row.is_primary,
    executionId: row.execution_id,
    latestSequence: row.latest_sequence,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}
