import { assertActiveExecution } from './execution-guard.js'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

export const workbenchMigrationSql = `
CREATE TABLE IF NOT EXISTS workbench_versions (
  kind text NOT NULL CHECK (kind IN ('stance', 'page')),
  entity_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, entity_id, revision)
);
CREATE TABLE IF NOT EXISTS workbench_operations (
  operation_id text PRIMARY KEY,
  payload jsonb NOT NULL,
  result jsonb NOT NULL
);
`

export type StanceRecord = {
  id: string; symbol: string; revision: number; stance: string
  status: 'suggested' | 'confirmed' | 'pending'; conditions: string[]
  sourceThreadId: string | null; sourceRecordId: string | null; updatedAt: string
  sourceRecordKind: 'research' | 'conversation' | null; sourceReportVersionId: string | null
}
export type WorkbenchBlock = {
  type: 'positions' | 'stances' | 'watchlist' | 'research'; title?: string; symbols?: string[]
}
export type WorkbenchPage = { id: string; revision: number; title: string; blocks: WorkbenchBlock[]; updatedAt: string }
export type SaveStanceInput = Omit<StanceRecord, 'id' | 'revision' | 'updatedAt' | 'sourceRecordKind' | 'sourceReportVersionId'> & { operationId: string; sourceReportVersionId?: string | null }
export type SavePageInput = Pick<WorkbenchPage, 'title' | 'blocks'> & { id?: string; operationId: string }
export type RestorePageInput = { id: string; revision: number; operationId: string }

export function createWorkbenchRepository(pool: Pool) {
  async function operation<T>(operationId: string, payload: object, action: (client: PoolClient) => Promise<T>, executionId?: string): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`workbench:operation:${operationId}`])
      const existing = await client.query<{ result: T; matches: boolean }>(
        'SELECT result, payload = $2::jsonb AS matches FROM workbench_operations WHERE operation_id = $1',
        [operationId, JSON.stringify(payload)],
      )
      if (existing.rows[0]) {
        if (!existing.rows[0].matches) throw new Error('workbench_operation_conflict')
        await client.query('COMMIT')
        return existing.rows[0].result
      }
      const result = await action(client)
      await assertActiveExecution(client, executionId)
      await client.query('INSERT INTO workbench_operations (operation_id, payload, result) VALUES ($1,$2,$3)', [operationId, JSON.stringify(payload), JSON.stringify(result)])
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
  async function append<T extends { id: string; revision: number; updatedAt: string }>(client: PoolClient, kind: string, id: string, payload: Omit<T, 'id' | 'revision' | 'updatedAt'>): Promise<T> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`workbench:${kind}:${id}`])
    const count = await client.query<{ revision: number }>('SELECT COALESCE(MAX(revision),0)::integer + 1 AS revision FROM workbench_versions WHERE kind=$1 AND entity_id=$2', [kind, id])
    const record = { ...payload, id, revision: count.rows[0]!.revision, updatedAt: new Date().toISOString() } as T
    await client.query('INSERT INTO workbench_versions (kind,entity_id,revision,payload) VALUES ($1,$2,$3,$4)', [kind, id, record.revision, JSON.stringify(record)])
    return record
  }
  async function list<T>(kind: string, id?: string): Promise<T[]> {
    const result = await pool.query<{ payload: T }>(`SELECT DISTINCT ON (entity_id) payload FROM workbench_versions WHERE kind=$1 AND ($2::text IS NULL OR entity_id=$2) ORDER BY entity_id,revision DESC`, [kind, id ?? null])
    return result.rows.map((row) => row.payload)
  }
  return {
    listStances: (symbol?: string) => list<StanceRecord>('stance', symbol),
    saveStance(input: SaveStanceInput, executionId?: string) {
      const { operationId, ...payload } = input
      return operation(operationId, { kind: 'stance', ...payload }, async (client) => {
        if (payload.sourceThreadId) {
          const thread = await client.query("SELECT id FROM analyses WHERE id=$1 AND kind='conversation'", [payload.sourceThreadId])
          if (!thread.rowCount) throw new Error('invalid_workbench_source_thread')
        }
        let sourceRecordKind: StanceRecord['sourceRecordKind'] = null
        if (payload.sourceRecordId) {
          const source = await client.query<{ kind: 'research' | 'conversation' }>('SELECT kind FROM analyses WHERE id=$1', [payload.sourceRecordId])
          if (!source.rows[0]) throw new Error('invalid_workbench_source_record')
          sourceRecordKind = source.rows[0].kind
        }
        const sourceReportVersionId = payload.sourceReportVersionId ?? null
        if (sourceReportVersionId) {
          const version = await client.query('SELECT id FROM report_versions WHERE id=$1 AND analysis_id=$2', [sourceReportVersionId, payload.sourceRecordId])
          if (!version.rowCount) throw new Error('invalid_workbench_source_report_version')
        }
        return append<StanceRecord>(client, 'stance', payload.symbol, { ...payload, sourceRecordKind, sourceReportVersionId })
      }, executionId)
    },
    listPages: () => list<WorkbenchPage>('page'),
    async getPage(id: string) {
      const result = await pool.query<{ payload: WorkbenchPage }>('SELECT payload FROM workbench_versions WHERE kind=\'page\' AND entity_id=$1 ORDER BY revision DESC', [id])
      const versions = result.rows.map((row) => row.payload)
      return versions[0] ? { page: versions[0], versions } : null
    },
    savePage(input: SavePageInput, executionId?: string) {
      const { operationId, id, ...payload } = input
      return operation(operationId, { kind: 'page', id: id ?? null, ...payload }, async (client) => {
        if (id) {
          const found = await client.query('SELECT 1 FROM workbench_versions WHERE kind=\'page\' AND entity_id=$1 LIMIT 1', [id])
          if (!found.rowCount) throw new Error('workbench_page_not_found')
        }
        return append<WorkbenchPage>(client, 'page', id ?? randomUUID(), payload)
      }, executionId)
    },
    restorePage(input: RestorePageInput, executionId?: string) {
      return operation(input.operationId, { kind: 'restore_page', id: input.id, revision: input.revision }, async (client) => {
        const result = await client.query<{ payload: WorkbenchPage }>('SELECT payload FROM workbench_versions WHERE kind=\'page\' AND entity_id=$1 AND revision=$2', [input.id, input.revision])
        const previous = result.rows[0]?.payload
        if (!previous) throw new Error('workbench_page_not_found')
        return append<WorkbenchPage>(client, 'page', input.id, { title: previous.title, blocks: previous.blocks })
      }, executionId)
    },
  }
}
export type WorkbenchRepository = ReturnType<typeof createWorkbenchRepository>
