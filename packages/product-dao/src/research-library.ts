import type { Pool } from 'pg'
import { assertActiveExecution } from './execution-guard.js'

export const researchSourceMigrationSql = `
CREATE TABLE IF NOT EXISTS research_source_links (
  thread_id text NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  source_record_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('research','conversation')),
  title text NOT NULL,
  report_versions jsonb NOT NULL,
  message_sequences jsonb NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id,source_record_id)
);
`
export type ResearchSourceInput = {
  sourceRecordId: string; kind: 'research' | 'conversation'; title: string
  reportVersions: Array<{id: string; version: number}>; messageSequences: number[]
}

export type ResearchLibraryQuery = { q?: string; symbol?: string; offset?: number; limit?: number }
export type ResearchLibraryRecord = {
  id: string; kind: 'research' | 'conversation'; title: string; symbol: string | null
  createdAt: string; updatedAt: string; reportCreatedAt: string | null
}

const visibleMessages = `SELECT session.analysis_id, event.sequence, event.created_at,
  CASE WHEN event.payload_json->>'type' = 'chat_completed' THEN 'assistant' ELSE 'user' END AS role,
  CASE WHEN event.payload_json->>'type' = 'chat_completed' THEN event.payload_json->>'text'
    ELSE event.payload_json->>'message' END AS text
  FROM agent_events event JOIN agent_sessions session ON session.id = event.session_id
  WHERE session.is_primary AND event.payload_json->>'type' IN ('user_message','runtime_follow_up','chat_completed')`
const columns = `id, kind, symbol, note AS title, created_at, updated_at, report_created_at`

type Row = { id: string; kind: 'research' | 'conversation'; symbol: string | null; title: string; created_at: Date; updated_at: Date; report_created_at: Date | null }
function record(row: Row): ResearchLibraryRecord {
  return { id: row.id, kind: row.kind, symbol: row.symbol,
    title: row.title || (row.symbol ? `${row.symbol} 研究` : '研究对话'),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    reportCreatedAt: row.report_created_at?.toISOString() ?? null }
}
function pagination(offset = 0, limit = 20) {
  return { offset: Number.isSafeInteger(offset) ? Math.max(0, offset) : 0,
    limit: Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 20 }
}
function pattern(value: string) { return `%${value.replace(/[\\%_]/g, '\\$&')}%` }

export function createResearchLibraryRepository(pool: Pool) {
  return {
    async recordSource(threadId: string, input: ResearchSourceInput, executionId?: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`INSERT INTO research_source_links
        (thread_id,source_record_id,kind,title,report_versions,message_sequences)
        SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM analyses WHERE id=$1 AND kind='conversation')
        ON CONFLICT(thread_id,source_record_id) DO UPDATE SET
          report_versions=(SELECT COALESCE(jsonb_agg(DISTINCT value),'[]'::jsonb) FROM jsonb_array_elements(research_source_links.report_versions || EXCLUDED.report_versions)),
          message_sequences=(SELECT COALESCE(jsonb_agg(DISTINCT value),'[]'::jsonb) FROM jsonb_array_elements(research_source_links.message_sequences || EXCLUDED.message_sequences)),
          read_at=now()`,[threadId,input.sourceRecordId,input.kind,input.title,JSON.stringify(input.reportVersions),JSON.stringify(input.messageSequences)])
        if (executionId) await assertActiveExecution(client,executionId)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async listSources(threadId: string) {
      const result = await pool.query<{
        source_record_id: string; kind: 'research' | 'conversation'; title: string
        report_versions: Array<{id: string; version: number}>; message_sequences: number[]
        read_at: Date; available: boolean
      }>(`SELECT link.*, analysis.id IS NOT NULL AS available FROM research_source_links link
        LEFT JOIN analyses analysis ON analysis.id=link.source_record_id
        WHERE link.thread_id=$1 ORDER BY link.read_at,link.source_record_id`,[threadId])
      return result.rows.map((row) => ({sourceRecordId: row.source_record_id, kind: row.kind,
        title: row.title, reportVersions: row.report_versions, messageSequences: row.message_sequences.sort((a,b) => a-b),
        readAt: row.read_at.toISOString(), available: row.available}))
    },
    async search(input: ResearchLibraryQuery = {}) {
      const { offset, limit } = pagination(input.offset, input.limit)
      const result = await pool.query<{ records: Row[]; total: number }>(`
        WITH messages AS (${visibleMessages}), matches AS (
          SELECT ${columns} FROM analyses analysis WHERE
          ($1::text IS NULL OR analysis.symbol ILIKE $1 OR analysis.note ILIKE $1
            OR EXISTS (SELECT 1 FROM messages WHERE analysis_id = analysis.id AND text ILIKE $1)
            OR EXISTS (SELECT 1 FROM report_versions report WHERE report.analysis_id = analysis.id
              AND EXISTS (SELECT 1 FROM jsonb_each(report.report_json) field
                WHERE field.key IN ('title','marketState','trend','drivers','supportingEvidence',
                  'contraryEvidence','scenarios','invalidationConditions','valuation','personalImpact',
                  'conditionalSuggestion','limitations','keyJudgments','summary','markdown')
                AND field.value::text ILIKE $1)))
          AND ($2::text IS NULL OR upper(analysis.symbol) = $2
            OR EXISTS (SELECT 1 FROM messages WHERE analysis_id = analysis.id AND text ~* $3))
        ), page AS (SELECT * FROM matches ORDER BY updated_at DESC,id LIMIT $4 OFFSET $5)
        SELECT COALESCE((SELECT json_agg(page) FROM page),'[]'::json) AS records,
          (SELECT count(*)::integer FROM matches) AS total`,
      [input.q?.trim() ? pattern(input.q.trim()) : null,input.symbol?.trim().toUpperCase() || null,
        input.symbol?.trim() ? `\\m${input.symbol.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\M` : null,limit,offset])
      const row = result.rows[0]!
      return {
        items: row.records.map((item) => record({
          ...item, created_at: new Date(item.created_at), updated_at: new Date(item.updated_at),
          report_created_at: item.report_created_at ? new Date(item.report_created_at) : null,
        })),
        total: row.total, offset, limit,
      }
    },
    async read(id: string, requestedOffset?: number, requestedLimit?: number) {
      const { offset, limit } = pagination(requestedOffset, requestedLimit)
      const result = await pool.query<Row>(`SELECT ${columns} FROM analyses WHERE id = $1`,[id])
      if (!result.rows[0]) return null
      const [messages,reports,count,facts] = await Promise.all([
        pool.query<{sequence:number; role:'user'|'assistant'; text:string; created_at:Date}>(`WITH messages AS (${visibleMessages}) SELECT sequence,role,text,created_at FROM messages WHERE analysis_id = $1 AND text IS NOT NULL ORDER BY sequence LIMIT $2 OFFSET $3`,[id,limit,offset]),
        pool.query<{id:string;version:number;kind:string;report:unknown;created_at:Date}>(`SELECT id,version,kind,report_json AS report,created_at FROM report_versions WHERE analysis_id = $1 ORDER BY created_at DESC,id DESC LIMIT 100`,[id]),
        pool.query<{total:number}>(`WITH messages AS (${visibleMessages}) SELECT count(*)::integer AS total FROM messages WHERE analysis_id=$1 AND text IS NOT NULL`,[id]),
        pool.query<{payload_json: Record<string, unknown>}>(`SELECT fact.payload_json FROM atomic_facts fact
          JOIN analysis_facts link ON link.fact_id=fact.id
          WHERE link.analysis_id=$1 AND fact.is_public ORDER BY fact.id`,[id]),
      ])
      return {
        facts: facts.rows.map((fact) => fact.payload_json),
        record: record(result.rows[0]),
        messages: messages.rows.map((message) => ({
          sequence: message.sequence, role: message.role, text: message.text,
          createdAt: message.created_at.toISOString(),
        })),
        reportVersions: reports.rows.map((report) => ({
          id: report.id, version: report.version, kind: report.kind,
          report: report.report, createdAt: report.created_at.toISOString(),
        })),
        total: count.rows[0]!.total, offset, limit,
      }
    },
  }
}
export type ResearchLibraryRepository = ReturnType<typeof createResearchLibraryRepository>
