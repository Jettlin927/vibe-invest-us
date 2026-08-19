import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import {
  executeLegacyPortfolioMigration,
  verifyLegacyPortfolioMigration,
  type LegacyPortfolioMigration,
  type MigrationVerificationState,
} from '@vibe-invest/product-dao'

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
  await executeLegacyPortfolioMigration({
    connectionString: options.databaseUrl,
    sourceSha256: sourceHash,
    sourcePath: options.source,
    data: migrationData(source),
  })
  return { sourceSha256: sourceHash, positions: source.positions.length, equitySnapshots: source.snapshots.length }
}

export async function verifyMigration(options: {
  source: string
  databaseUrl: string
  apiBaseUrl: string
  apiToken: string
}) {
  const source = readLegacy(options.source)
  const expected = verificationState(source)
  await verifyLegacyPortfolioMigration(options.databaseUrl, expected)
  await verifyApiReadback(options.apiBaseUrl, options.apiToken, expected)
  return {
    positions: expected.positions.length,
    cash: true,
    equitySnapshots: expected.snapshots.length,
    database: 'verified' as const,
  }
}

async function verifyApiReadback(
  apiBaseUrl: string,
  apiToken: string,
  expected: MigrationVerificationState,
) {
  const state = await fetch(`${apiBaseUrl}/api/migration-verification`, {
    headers: { authorization: `Bearer ${apiToken}` },
  }).then(requireOk) as {
    positions: Array<{ symbol: string; quantity: string; averageCost: string }>
    cash: string
    snapshots: Array<{
      marketDay: string; totalEquity: string; totalMarketValue: string; cash: string
    }>
  }
  const actual = normalizeVerificationState(state)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('legacy_migration_api_verification_failed')
}

async function requireOk(response: Response) {
  if (!response.ok) throw new Error('legacy_migration_api_verification_failed')
  return response.json()
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

type LegacyData = ReturnType<typeof readLegacy>

function migrationData(source: LegacyData): LegacyPortfolioMigration {
  return {
    positions: source.positions.map((row) => ({
      symbol: row.symbol, quantity: decimal(row.quantity),
      averageCost: decimal(row.average_cost), updatedAt: row.updated_at,
    })),
    cash: { value: decimal(source.cash.cash), updatedAt: source.cash.updated_at },
    snapshots: source.snapshots.map((row) => ({
      marketDay: row.market_day, totalEquity: decimal(row.total_equity),
      totalMarketValue: decimal(row.total_market_value), cash: decimal(row.cash),
      holdingsCount: row.holdings_count, pricedCount: row.priced_count,
      observedAt: row.observed_at, afterClose: row.after_close === 1,
    })),
  }
}

function verificationState(source: LegacyData): MigrationVerificationState {
  return {
    positions: source.positions.map((row) => ({
      symbol: row.symbol, quantity: decimal(row.quantity), averageCost: decimal(row.average_cost),
    })).sort((left, right) => left.symbol.localeCompare(right.symbol)),
    cash: decimal(source.cash.cash),
    snapshots: source.snapshots.map((row) => ({
      marketDay: row.market_day, totalEquity: decimal(row.total_equity),
      totalMarketValue: decimal(row.total_market_value), cash: decimal(row.cash),
    })).sort((left, right) => left.marketDay.localeCompare(right.marketDay)),
  }
}

function normalizeVerificationState(state: MigrationVerificationState): MigrationVerificationState {
  return {
    positions: state.positions.map((row) => ({
      symbol: row.symbol, quantity: decimal(row.quantity), averageCost: decimal(row.averageCost),
    })).sort((left, right) => left.symbol.localeCompare(right.symbol)),
    cash: decimal(state.cash),
    snapshots: state.snapshots.map((row) => ({
      marketDay: row.marketDay, totalEquity: decimal(row.totalEquity),
      totalMarketValue: decimal(row.totalMarketValue), cash: decimal(row.cash),
    })).sort((left, right) => left.marketDay.localeCompare(right.marketDay)),
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
