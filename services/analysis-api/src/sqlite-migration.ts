import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { createPool } from '@vibe-invest/product-dao'

type LegacyPosition = { symbol: string; quantity: string; average_cost: string; updated_at: string }
type LegacyCash = { cash: string; updated_at: string }
type LegacySnapshot = {
  market_day: string
  total_equity: string
  total_market_value: string
  cash: string
  holdings_count: number
  priced_count: number
  observed_at: string
  after_close: number
}

export async function planMigration(source: string) {
  const database = openLegacy(source)
  try {
    return {
      source,
      migrate: {
        positions: count(database, 'positions'),
        cash: count(database, 'portfolio_settings'),
        equitySnapshots: count(database, 'portfolio_equity_snapshots'),
      },
      abandon: {
        research: count(database, 'analyses'),
        reports: countWhere(database, 'analyses', 'report_json IS NOT NULL'),
        analysisSnapshots: countWhere(database, 'analyses', 'snapshot_json IS NOT NULL'),
        facts: count(database, 'atomic_facts'),
        traces: count(database, 'analysis_trace'),
      },
    }
  } finally {
    database.close()
  }
}

export async function executeMigration(options: {
  source: string
  databaseUrl: string
  apiHealthUrl: string
}) {
  await assertApiStopped(options.apiHealthUrl)
  const sourceHash = sha256(options.source)
  const source = readLegacy(options.source)
  const pool = createPool(options.databaseUrl)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const receipt = await client.query(
      'SELECT source_sha256 FROM legacy_portfolio_migrations WHERE source_sha256 = $1',
      [sourceHash],
    )
    if (receipt.rowCount) throw new Error('legacy_migration_already_executed')
    const target = await client.query<{ positions: number; snapshots: number; cash: string }>(
      `SELECT (SELECT count(*)::integer FROM positions) AS positions,
              (SELECT count(*)::integer FROM portfolio_equity_snapshots) AS snapshots,
              (SELECT cash::text FROM portfolio_settings WHERE id = 1 FOR UPDATE) AS cash`,
    )
    const current = target.rows[0]
    if (!current || current.positions > 0 || current.snapshots > 0 || current.cash !== '0') {
      throw new Error('legacy_migration_target_conflict')
    }
    for (const position of source.positions) {
      await client.query(
        `INSERT INTO positions (symbol, quantity, average_cost, updated_at)
         VALUES ($1, $2, $3, $4)`,
        [position.symbol, decimal(position.quantity), decimal(position.average_cost), position.updated_at],
      )
    }
    await client.query(
      'UPDATE portfolio_settings SET cash = $1, updated_at = $2 WHERE id = 1',
      [decimal(source.cash.cash), source.cash.updated_at],
    )
    for (const snapshot of source.snapshots) {
      await client.query(
        `INSERT INTO portfolio_equity_snapshots (
           market_day, total_equity, total_market_value, cash,
           holdings_count, priced_count, observed_at, after_close
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [snapshot.market_day, decimal(snapshot.total_equity), decimal(snapshot.total_market_value),
          decimal(snapshot.cash), snapshot.holdings_count, snapshot.priced_count,
          snapshot.observed_at, snapshot.after_close === 1],
      )
    }
    await client.query(
      `INSERT INTO legacy_portfolio_migrations (source_sha256, source_path)
       VALUES ($1, $2)`,
      [sourceHash, options.source],
    )
    await client.query('COMMIT')
    return { sourceSha256: sourceHash, positions: source.positions.length, equitySnapshots: source.snapshots.length }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

export async function verifyMigration(options: {
  source: string
  databaseUrl: string
  apiBaseUrl?: string
}) {
  const source = readLegacy(options.source)
  const pool = createPool(options.databaseUrl)
  try {
    const positions = await pool.query<{ symbol: string; quantity: string; average_cost: string }>(
      'SELECT symbol, quantity::text, average_cost::text FROM positions ORDER BY symbol',
    )
    const cash = await pool.query<{ cash: string }>(
      'SELECT cash::text FROM portfolio_settings WHERE id = 1',
    )
    const snapshots = await pool.query<{
      market_day: string; total_equity: string; total_market_value: string; cash: string
    }>(
      `SELECT market_day::text, total_equity::text, total_market_value::text, cash::text
       FROM portfolio_equity_snapshots ORDER BY market_day`,
    )
    const expectedPositions = source.positions.map((row) => ({
      symbol: row.symbol, quantity: decimal(row.quantity), average_cost: decimal(row.average_cost),
    })).sort((left, right) => left.symbol.localeCompare(right.symbol))
    const expectedSnapshots = source.snapshots.map((row) => ({
      market_day: row.market_day, total_equity: decimal(row.total_equity),
      total_market_value: decimal(row.total_market_value), cash: decimal(row.cash),
    })).sort((left, right) => left.market_day.localeCompare(right.market_day))
    if (
      JSON.stringify(positions.rows) !== JSON.stringify(expectedPositions)
      || cash.rows[0]?.cash !== decimal(source.cash.cash)
      || JSON.stringify(snapshots.rows) !== JSON.stringify(expectedSnapshots)
    ) throw new Error('legacy_migration_verification_failed')
    if (options.apiBaseUrl) {
      await verifyApiReadback(
        options.apiBaseUrl,
        expectedPositions,
        expectedSnapshots,
        decimal(source.cash.cash),
      )
    }
    return {
      positions: expectedPositions.length,
      cash: true,
      equitySnapshots: expectedSnapshots.length,
      database: 'verified' as const,
    }
  } finally {
    await pool.end()
  }
}

async function verifyApiReadback(
  apiBaseUrl: string,
  positions: Array<{ symbol: string; quantity: string; average_cost: string }>,
  snapshots: Array<{
    market_day: string; total_equity: string; total_market_value: string; cash: string
  }>,
  cash: string,
) {
  const listed = await fetchText(`${apiBaseUrl}/api/positions`)
  const actualPositions = [...listed.matchAll(
    /\{"symbol":"([^"]+)","quantity":(-?[\d.eE+]+),"averageCost":(-?[\d.eE+]+)\}/g,
  )].map((match) => ({ symbol: match[1]!, quantity: decimal(match[2]!), average_cost: decimal(match[3]!) }))
  if (JSON.stringify(actualPositions) !== JSON.stringify(positions)) {
    throw new Error('legacy_migration_api_verification_failed')
  }
  const history = await fetchText(`${apiBaseUrl}/api/portfolio/history?limit=365`)
  const actualSnapshots = [...history.matchAll(
    /\{"marketDay":"([^"]+)","totalEquity":(-?[\d.eE+]+),"totalMarketValue":(-?[\d.eE+]+),"cash":(-?[\d.eE+]+)/g,
  )].map((match) => ({
    market_day: match[1]!, total_equity: decimal(match[2]!),
    total_market_value: decimal(match[3]!), cash: decimal(match[4]!),
  })).sort((left, right) => left.market_day.localeCompare(right.market_day))
  if (JSON.stringify(actualSnapshots) !== JSON.stringify(snapshots)) {
    throw new Error('legacy_migration_api_verification_failed')
  }
  const portfolio = await fetchText(`${apiBaseUrl}/api/portfolio`)
  const actualCash = portfolio.match(/"cash":(-?[\d.eE+]+)/)?.[1]
  if (!actualCash || decimal(actualCash) !== cash) throw new Error('legacy_migration_api_verification_failed')
}

async function fetchText(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error('legacy_migration_api_verification_failed')
  return response.text()
}

async function assertApiStopped(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
    if (response) throw new Error('api_must_be_stopped')
  } catch (error) {
    if (error instanceof Error && error.message === 'api_must_be_stopped') throw error
  }
}

function readLegacy(sourcePath: string) {
  const database = openLegacy(sourcePath)
  try {
    const cash = database.prepare('SELECT cash, updated_at FROM portfolio_settings WHERE id = 1')
      .get() as LegacyCash | undefined
    if (!cash) throw new Error('legacy_cash_missing')
    return {
      positions: database.prepare(
        `SELECT symbol, CAST(quantity AS TEXT) AS quantity,
                CAST(average_cost AS TEXT) AS average_cost, updated_at
         FROM positions ORDER BY symbol`,
      ).all() as LegacyPosition[],
      cash: { ...cash, cash: String(cash.cash) },
      snapshots: database.prepare(
        `SELECT market_day, CAST(total_equity AS TEXT) AS total_equity,
                CAST(total_market_value AS TEXT) AS total_market_value,
                CAST(cash AS TEXT) AS cash,
                holdings_count, priced_count, observed_at, after_close
         FROM portfolio_equity_snapshots ORDER BY market_day`,
      ).all() as LegacySnapshot[],
    }
  } finally {
    database.close()
  }
}

function openLegacy(path: string) {
  if (!existsSync(path)) throw new Error('legacy_sqlite_not_found')
  return new DatabaseSync(path, { readOnly: true })
}

function count(database: DatabaseSync, table: string) {
  if (!tableExists(database, table)) return 0
  return Number((database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count)
}

function countWhere(database: DatabaseSync, table: string, where: string) {
  if (!tableExists(database, table)) return 0
  return Number((database.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number }).count)
}

function tableExists(database: DatabaseSync, table: string) {
  return Boolean(database.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table))
}

function sha256(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function decimal(value: string) {
  return normalizeDecimal(value)
}

function normalizeDecimal(value: string) {
  const match = value.trim().match(/^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/)
  if (!match) throw new Error('legacy_decimal_invalid')
  const sign = match[1] === '-' ? '-' : ''
  const integer = match[2]!
  const fraction = match[3] ?? ''
  const exponent = Number(match[4] ?? 0)
  if (!Number.isSafeInteger(exponent)) throw new Error('legacy_decimal_invalid')
  const digits = `${integer}${fraction}`
  const point = integer.length + exponent
  const expanded = point <= 0
    ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length
      ? `${digits}${'0'.repeat(point - digits.length)}`
      : `${digits.slice(0, point)}.${digits.slice(point)}`
  const [whole, decimals = ''] = expanded.split('.')
  const normalizedWhole = whole!.replace(/^0+(?=\d)/, '')
  const normalizedFraction = decimals.replace(/0+$/, '')
  const normalized = normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole
  return normalized === '0' ? '0' : `${sign}${normalized}`
}
