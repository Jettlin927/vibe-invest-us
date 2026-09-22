import { Pool, type PoolClient } from 'pg'
import { defaultRuntimeSettings, parseRuntimeSettingsUpdate, type ExecutionSettingsSnapshot, type RuntimeSettings, type RuntimeSettingsRevision } from '@vibe-invest/contracts'

type RuntimeSettingsRevisionRow = {
  id: number
  settings_json: RuntimeSettings
  created_at: string
}

type ExecutionSettingsSnapshotRow = RuntimeSettingsRevisionRow & {
  execution_id: string
}

export async function freezeExecutionSettings(
  database: Pool | PoolClient, executionId: string, frozenAt: string,
) {
  return database.query<ExecutionSettingsSnapshotRow>(
    `WITH inserted AS (
       INSERT INTO execution_settings_snapshots (execution_id, revision_id, settings_json, frozen_at)
       SELECT $1, id, settings_json, $2 FROM runtime_settings_revisions ORDER BY id DESC LIMIT 1
       ON CONFLICT (execution_id) DO NOTHING
       RETURNING execution_id, revision_id, settings_json, frozen_at
     )
     SELECT execution_id, revision_id AS id, settings_json, frozen_at::text AS created_at
     FROM inserted
     UNION ALL
     SELECT execution_id, revision_id AS id, settings_json, frozen_at::text AS created_at
     FROM execution_settings_snapshots WHERE execution_id = $1
     LIMIT 1`,
    [executionId, frozenAt],
  )
}

export function createRuntimeSettingsRepository(pool: Pool) {
  const mapRevision = (row: RuntimeSettingsRevisionRow): RuntimeSettingsRevision => ({
    id: row.id,
    values: { ...defaultRuntimeSettings, ...row.settings_json },
    createdAt: row.created_at,
  })
  const mapSnapshot = (row: ExecutionSettingsSnapshotRow): ExecutionSettingsSnapshot => ({
    executionId: row.execution_id, ...mapRevision(row),
  })
  return {
    async current() {
      const result = await pool.query<RuntimeSettingsRevisionRow>(
        `SELECT id, settings_json, created_at::text FROM runtime_settings_revisions
         ORDER BY id DESC LIMIT 1`,
      )
      if (!result.rows[0]) throw new Error('runtime_settings_revision_not_found')
      return mapRevision(result.rows[0])
    },
    async getRevision(id: number) {
      const result = await pool.query<RuntimeSettingsRevisionRow>(
        `SELECT id, settings_json, created_at::text FROM runtime_settings_revisions WHERE id = $1`,
        [id],
      )
      return result.rows[0] ? mapRevision(result.rows[0]) : null
    },
    async save(update: unknown, createdAt: string) {
      const parsed = parseRuntimeSettingsUpdate(update)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock($1)', [8_613_092])
        const current = await client.query<RuntimeSettingsRevisionRow>(
          `SELECT id, settings_json, created_at::text FROM runtime_settings_revisions
           ORDER BY id DESC LIMIT 1`,
        )
        if (!current.rows[0]) throw new Error('runtime_settings_revision_not_found')
        const values = { ...current.rows[0].settings_json, ...parsed }
        const result = await client.query<RuntimeSettingsRevisionRow>(
          `INSERT INTO runtime_settings_revisions (settings_json, created_at)
           VALUES ($1, $2) RETURNING id, settings_json, created_at::text`,
          [JSON.stringify(values), createdAt],
        )
        await client.query('COMMIT')
        return mapRevision(result.rows[0]!)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async restoreDefaults(createdAt: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock($1)', [8_613_092])
        const result = await client.query<RuntimeSettingsRevisionRow>(
          `INSERT INTO runtime_settings_revisions (settings_json, created_at)
           VALUES ($1, $2) RETURNING id, settings_json, created_at::text`,
          [JSON.stringify(defaultRuntimeSettings), createdAt],
        )
        await client.query('COMMIT')
        return mapRevision(result.rows[0]!)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async freezeExecution(executionId: string, frozenAt: string) {
      const result = await freezeExecutionSettings(pool, executionId, frozenAt)
      return mapSnapshot(result.rows[0]!)
    },
    async getExecutionSnapshot(executionId: string) {
      const result = await pool.query<ExecutionSettingsSnapshotRow>(
        `SELECT execution_id, revision_id AS id, settings_json, frozen_at::text AS created_at
         FROM execution_settings_snapshots WHERE execution_id = $1`,
        [executionId],
      )
      return result.rows[0] ? mapSnapshot(result.rows[0]) : null
    },
    async listActiveExecutionSnapshots() {
      const result = await pool.query<ExecutionSettingsSnapshotRow>(
        `SELECT snapshot.execution_id, snapshot.revision_id AS id, snapshot.settings_json,
                snapshot.frozen_at::text AS created_at
         FROM execution_settings_snapshots snapshot
         JOIN agent_executions execution ON execution.id = snapshot.execution_id
         WHERE execution.terminal = false
         ORDER BY snapshot.frozen_at, snapshot.execution_id`,
      )
      return result.rows.map(mapSnapshot)
    },
  }
}

export type RuntimeSettingsRepository = ReturnType<typeof createRuntimeSettingsRepository>
