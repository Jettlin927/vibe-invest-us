import { calculateBuy, calculateSell, type ProductPosition, type PortfolioEvent, type ProductEquitySnapshot } from '@vibe-invest/domain/portfolio'
import { assertActiveExecution } from './execution-guard.js'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { createPool } from './schema.js'

export type MigrationVerificationState = {
  positions: Array<{ symbol: string; quantity: string; averageCost: string }>
  cash: string
  snapshots: Array<{
    marketDay: string
    totalEquity: string
    totalMarketValue: string
    cash: string
  }>
}

export type LegacyPortfolioMigration = {
  positions: Array<{ symbol: string; quantity: string; averageCost: string; updatedAt: string }>
  cash: { value: string; updatedAt: string }
  snapshots: Array<{
    marketDay: string
    totalEquity: string
    totalMarketValue: string
    cash: string
    holdingsCount: number
    pricedCount: number
    observedAt: string
    afterClose: boolean
  }>
}

export async function executeLegacyPortfolioMigration(options: {
  connectionString: string
  sourceSha256: string
  sourcePath: string
  data: LegacyPortfolioMigration
}) {
  const pool = createPool(options.connectionString)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const receipt = await client.query(
      'SELECT source_sha256 FROM legacy_portfolio_migrations WHERE source_sha256 = $1',
      [options.sourceSha256],
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
    for (const position of options.data.positions) {
      await client.query(
        `INSERT INTO positions (symbol, quantity, average_cost, updated_at)
         VALUES ($1, $2, $3, $4)`,
        [position.symbol, position.quantity, position.averageCost, position.updatedAt],
      )
      await client.query(
        `INSERT INTO portfolio_events (id, kind, symbol, quantity, price, note, created_at)
         VALUES ($1, 'reconcile', $2, $3, $4, '期初建仓：迁移自手工快照持仓', $5)`,
        ['opening:position:' + position.symbol, position.symbol,
          position.quantity, position.averageCost, position.updatedAt],
      )
    }
    await client.query(
      'UPDATE portfolio_settings SET cash = $1, updated_at = $2 WHERE id = 1',
      [options.data.cash.value, options.data.cash.updatedAt],
    )
    if (Number(options.data.cash.value) > 0) {
      await client.query(
        `INSERT INTO portfolio_events (id, kind, amount, note, created_at)
         VALUES ('opening:cash', 'cash_adjust', $1, '期初入金：迁移自手工维护现金', $2)`,
        [options.data.cash.value, options.data.cash.updatedAt],
      )
    }
    for (const snapshot of options.data.snapshots) {
      await client.query(
        `INSERT INTO portfolio_equity_snapshots (
           market_day, total_equity, total_market_value, cash,
           holdings_count, priced_count, observed_at, after_close
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [snapshot.marketDay, snapshot.totalEquity, snapshot.totalMarketValue, snapshot.cash,
          snapshot.holdingsCount, snapshot.pricedCount, snapshot.observedAt, snapshot.afterClose],
      )
    }
    await client.query(
      `INSERT INTO legacy_portfolio_migrations (source_sha256, source_path)
       VALUES ($1, $2)`,
      [options.sourceSha256, options.sourcePath],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

export async function verifyLegacyPortfolioMigration(
  connectionString: string,
  expected: MigrationVerificationState,
) {
  const pool = createPool(connectionString)
  try {
    const actual = await createPortfolioRepository(pool).migrationVerificationState()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('legacy_migration_verification_failed')
    }
  } finally {
    await pool.end()
  }
}

type PositionRow = { symbol: string; quantity: string; average_cost: string }

type EventRow = {
  id: string
  kind: 'buy' | 'sell' | 'cash_adjust' | 'reconcile'
  symbol: string | null
  quantity: string | null
  price: string | null
  amount: string | null
  realized_pnl: string | null
  note: string
  created_at: string
}

async function insertEvent(
  client: PoolClient,
  event: {
    kind: PortfolioEvent['kind']
    symbol?: string
    quantity?: number
    price?: number
    amount?: number
    realizedProfitLoss?: number
    note?: string
    createdAt: string
  },
): Promise<PortfolioEvent> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO portfolio_events (id, kind, symbol, quantity, price, amount, realized_pnl, note, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, event.kind, event.symbol ?? null,
      event.quantity === undefined ? null : String(event.quantity),
      event.price === undefined ? null : String(event.price),
      event.amount === undefined ? null : String(event.amount),
      event.realizedProfitLoss === undefined ? null : String(event.realizedProfitLoss),
      event.note ?? '', event.createdAt],
  )
  return {
    id, kind: event.kind, symbol: event.symbol ?? null,
    quantity: event.quantity ?? null, price: event.price ?? null,
    amount: event.amount ?? null, realizedProfitLoss: event.realizedProfitLoss ?? null,
    note: event.note ?? '', createdAt: event.createdAt,
  }
}

function toEvent(row: EventRow): PortfolioEvent {
  return {
    id: row.id,
    kind: row.kind,
    symbol: row.symbol,
    quantity: row.quantity === null ? null : Number(row.quantity),
    price: row.price === null ? null : Number(row.price),
    amount: row.amount === null ? null : Number(row.amount),
    realizedProfitLoss: row.realized_pnl === null ? null : Number(row.realized_pnl),
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

type SnapshotRow = {
  market_day: string
  total_equity: string
  total_market_value: string
  cash: string
  holdings_count: number
  priced_count: number
  observed_at: string
  after_close: boolean
}

type PortfolioBuyResult = { event: PortfolioEvent; position: ProductPosition; cash: number; spent: number }

type PortfolioSellResult = { event: PortfolioEvent; position: ProductPosition | null; cash: number; proceeds: number; realizedProfitLoss: number }

// 与账本修改共用事务，保证重试不会覆盖其后发生的买卖或资金变化。
async function readPortfolioOperation<T>(client: PoolClient, operationId: string | undefined, payload: string): Promise<T | undefined> {
  if (!operationId) return undefined
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [operationId])
  const previous = await client.query<{ matches: boolean; result_json: T }>(
    'SELECT payload_json = $2::jsonb AS matches, result_json FROM portfolio_trade_operations WHERE operation_id = $1',
    [operationId, payload],
  )
  if (!previous.rows[0]) return undefined
  if (!previous.rows[0].matches) throw new Error('portfolio_operation_conflict')
  return previous.rows[0].result_json
}

async function savePortfolioOperation(client: PoolClient, operationId: string | undefined, payload: string, result: unknown) {
  if (operationId) await client.query(
    'INSERT INTO portfolio_trade_operations (operation_id, payload_json, result_json) VALUES ($1, $2, $3)',
    [operationId, payload, JSON.stringify(result)],
  )
}

export function createPortfolioRepository(pool: Pool) {
  return {
    async list(): Promise<ProductPosition[]> {
      const result = await pool.query<PositionRow>(
        `SELECT symbol, quantity::text, average_cost::text
         FROM positions ORDER BY symbol`,
      )
      return result.rows.map(toPosition)
    },
    async cash() {
      const result = await pool.query<{ cash: string }>(
        'SELECT cash::text FROM portfolio_settings WHERE id = $1',
        [1],
      )
      return Number(result.rows[0]?.cash ?? 0)
    },
    // 买入（加仓）：同一事务内追加事件、扣减现金、按加权平均更新持仓投影；现金不足时整体回滚。
    async recordBuy(symbol: string, quantity: number, price: number, note = '', operationId?: string, executionId?: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const operationPayload = JSON.stringify({ side: 'buy', symbol, quantity, price, note })
        if (operationId) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [operationId])
          const previous = await client.query<{ matches: boolean; result_json: PortfolioBuyResult }>(
            'SELECT payload_json = $2::jsonb AS matches, result_json FROM portfolio_trade_operations WHERE operation_id = $1',
            [operationId, operationPayload],
          )
          if (previous.rows[0]) {
            if (!previous.rows[0].matches) throw new Error('portfolio_operation_conflict')
            await client.query('COMMIT')
            return previous.rows[0].result_json
          }
        }
        const cashResult = await client.query<{ cash: string }>(
          'SELECT cash::text FROM portfolio_settings WHERE id = $1 FOR UPDATE',
          [1],
        )
        const cash = Number(cashResult.rows[0]?.cash ?? 0)
        const positionResult = await client.query<PositionRow>(
          `SELECT symbol, quantity::text, average_cost::text
           FROM positions WHERE symbol = $1 FOR UPDATE`,
          [symbol],
        )
        const row = positionResult.rows[0]
        const purchase = calculateBuy(row ? toPosition(row) : null, cash, symbol, quantity, price)
        if (!purchase) {
          await client.query('ROLLBACK')
          return null
        }
        const { spent } = purchase
        const { quantity: nextQuantity, averageCost: nextAverageCost } = purchase.position
        const now = new Date().toISOString()
        await client.query(
          `INSERT INTO positions (symbol, quantity, average_cost, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (symbol) DO UPDATE SET
             quantity = excluded.quantity,
             average_cost = excluded.average_cost,
             updated_at = excluded.updated_at`,
          [symbol, String(nextQuantity), String(nextAverageCost), now],
        )
        const nextCash = purchase.cash
        await client.query(
          'UPDATE portfolio_settings SET cash = $1, updated_at = $2 WHERE id = $3',
          [String(nextCash), now, 1],
        )
        const event = await insertEvent(client, {
          kind: 'buy', symbol, quantity, price, amount: -spent, note, createdAt: now,
        })
        const result = {
          event,
          position: { symbol, quantity: nextQuantity, averageCost: nextAverageCost },
          cash: nextCash,
          spent,
        }
        await assertActiveExecution(client, executionId)
        if (operationId) await client.query(
          'INSERT INTO portfolio_trade_operations (operation_id, payload_json, result_json) VALUES ($1, $2, $3)',
          [operationId, operationPayload, JSON.stringify(result)],
        )
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    // 卖出（减仓）：同一事务内追加事件、增加现金、减少持仓数量并记录本次已实现盈亏。
    async recordSell(symbol: string, quantity: number, price: number, note = '', operationId?: string, executionId?: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const operationPayload = JSON.stringify({ side: 'sell', symbol, quantity, price, note })
        if (operationId) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [operationId])
          const previous = await client.query<{ matches: boolean; result_json: PortfolioSellResult }>(
            'SELECT payload_json = $2::jsonb AS matches, result_json FROM portfolio_trade_operations WHERE operation_id = $1',
            [operationId, operationPayload],
          )
          if (previous.rows[0]) {
            if (!previous.rows[0].matches) throw new Error('portfolio_operation_conflict')
            await client.query('COMMIT')
            return previous.rows[0].result_json
          }
        }
        const cashResult = await client.query<{ cash: string }>(
          'SELECT cash::text FROM portfolio_settings WHERE id = $1 FOR UPDATE',
          [1],
        )
        const positionResult = await client.query<PositionRow>(
          `SELECT symbol, quantity::text, average_cost::text
           FROM positions WHERE symbol = $1 FOR UPDATE`,
          [symbol],
        )
        const row = positionResult.rows[0]
        const sale = calculateSell(row ? toPosition(row) : null, Number(cashResult.rows[0]?.cash ?? 0), quantity, price)
        if (!sale) {
          await client.query('ROLLBACK')
          return null
        }
        const remaining = sale.position?.quantity ?? 0
        const { proceeds, cash, realizedProfitLoss } = sale
        const now = new Date().toISOString()
        if (remaining === 0) {
          await client.query('DELETE FROM positions WHERE symbol = $1', [symbol])
        } else {
          await client.query(
            'UPDATE positions SET quantity = $1, updated_at = $2 WHERE symbol = $3',
            [String(remaining), now, symbol],
          )
        }
        await client.query(
          'UPDATE portfolio_settings SET cash = $1, updated_at = $2 WHERE id = $3',
          [String(cash), now, 1],
        )
        const event = await insertEvent(client, {
          kind: 'sell', symbol, quantity, price, amount: proceeds,
          realizedProfitLoss, note, createdAt: now,
        })
        const result = {
          event,
          position: sale.position,
          cash,
          proceeds,
          realizedProfitLoss,
        }
        await assertActiveExecution(client, executionId)
        if (operationId) await client.query(
          'INSERT INTO portfolio_trade_operations (operation_id, payload_json, result_json) VALUES ($1, $2, $3)',
          [operationId, operationPayload, JSON.stringify(result)],
        )
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    // 资金调整：以目标现金值为输入，差额记一条入金或出金事件；现金只通过事件变化。
    async recordCashAdjustment(targetCash: number, note = '', operationId?: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const payload = JSON.stringify({ kind: 'cash_adjust', targetCash, note })
        const previous = await readPortfolioOperation<{ event: PortfolioEvent | null; cash: number }>(client, operationId, payload)
        if (previous) {
          await client.query('COMMIT')
          return previous
        }
        const cashResult = await client.query<{ cash: string }>(
          'SELECT cash::text FROM portfolio_settings WHERE id = $1 FOR UPDATE',
          [1],
        )
        const cash = Number(cashResult.rows[0]?.cash ?? 0)
        const delta = targetCash - cash
        if (targetCash < 0) {
          await client.query('ROLLBACK')
          return null
        }
        if (delta === 0) {
          const result = { event: null, cash }
          await savePortfolioOperation(client, operationId, payload, result)
          await client.query('COMMIT')
          return result
        }
        const now = new Date().toISOString()
        await client.query(
          'UPDATE portfolio_settings SET cash = $1, updated_at = $2 WHERE id = $3',
          [String(targetCash), now, 1],
        )
        const event = await insertEvent(client, {
          kind: 'cash_adjust', amount: delta,
          note: note || (delta > 0 ? '入金' : '出金'), createdAt: now,
        })
        const result = { event, cash: targetCash }
        await savePortfolioOperation(client, operationId, payload, result)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    // 校准：把某标的持仓对齐到实际数量与成本；现金不变，差额由事件留痕，保持账本可审计。
    async recordReconcile(symbol: string, quantity: number, averageCost: number, note = '', operationId?: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const payload = JSON.stringify({ kind: 'reconcile', symbol, quantity, averageCost, note })
        const previous = await readPortfolioOperation<{ event: PortfolioEvent; position: ProductPosition | null }>(client, operationId, payload)
        if (previous) {
          await client.query('COMMIT')
          return previous
        }
        // 和买入采用相同的锁顺序，也串行化尚不存在的持仓校准。
        await client.query('SELECT id FROM portfolio_settings WHERE id = 1 FOR UPDATE')
        await client.query(
          'SELECT symbol FROM positions WHERE symbol = $1 FOR UPDATE',
          [symbol],
        )
        const now = new Date().toISOString()
        if (quantity === 0) {
          await client.query('DELETE FROM positions WHERE symbol = $1', [symbol])
        } else {
          await client.query(
            `INSERT INTO positions (symbol, quantity, average_cost, updated_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (symbol) DO UPDATE SET
               quantity = excluded.quantity,
               average_cost = excluded.average_cost,
               updated_at = excluded.updated_at`,
            [symbol, String(quantity), String(averageCost), now],
          )
        }
        const event = await insertEvent(client, {
          kind: 'reconcile', symbol, quantity, price: averageCost,
          note: note || '校准持仓', createdAt: now,
        })
        const result = {
          event,
          position: quantity === 0 ? null : { symbol, quantity, averageCost },
        }
        await savePortfolioOperation(client, operationId, payload, result)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async listEvents(limit = 100): Promise<PortfolioEvent[]> {
      const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 500)) : 100
      const result = await pool.query<EventRow>(
        `SELECT id, kind, symbol, quantity::text, price::text, amount::text,
                realized_pnl::text, note, created_at::text
         FROM portfolio_events
         ORDER BY created_at DESC, id DESC LIMIT $1`,
        [safeLimit],
      )
      return result.rows.map(toEvent)
    },
    async saveSnapshot(snapshot: ProductEquitySnapshot) {
      const result = await pool.query(
        `INSERT INTO portfolio_equity_snapshots (
           market_day, total_equity, total_market_value, cash,
           holdings_count, priced_count, observed_at, after_close
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (market_day) DO UPDATE SET
           total_equity = excluded.total_equity,
           total_market_value = excluded.total_market_value,
           cash = excluded.cash,
           holdings_count = excluded.holdings_count,
           priced_count = excluded.priced_count,
           observed_at = excluded.observed_at,
           after_close = excluded.after_close
         WHERE portfolio_equity_snapshots.after_close = false OR excluded.after_close = true`,
        [snapshot.marketDay, String(snapshot.totalEquity), String(snapshot.totalMarketValue),
          String(snapshot.cash), snapshot.holdingsCount, snapshot.pricedCount,
          snapshot.observedAt, snapshot.afterClose],
      )
      return (result.rowCount ?? 0) > 0
    },
    async listSnapshots(limit: number): Promise<ProductEquitySnapshot[]> {
      const result = await pool.query<SnapshotRow>(
        `SELECT market_day::text, total_equity::text, total_market_value::text,
                cash::text, holdings_count, priced_count,
                observed_at::text, after_close
         FROM portfolio_equity_snapshots
         ORDER BY market_day DESC LIMIT $1`,
        [limit],
      )
      return result.rows.map((row) => ({
        marketDay: row.market_day,
        totalEquity: Number(row.total_equity),
        totalMarketValue: Number(row.total_market_value),
        cash: Number(row.cash),
        holdingsCount: row.holdings_count,
        pricedCount: row.priced_count,
        observedAt: new Date(row.observed_at).toISOString(),
        afterClose: row.after_close,
      }))
    },
    async migrationVerificationState(): Promise<MigrationVerificationState> {
      const [positions, cash, snapshots] = await Promise.all([
        pool.query<{ symbol: string; quantity: string; average_cost: string }>(
          'SELECT symbol, quantity::text, average_cost::text FROM positions ORDER BY symbol',
        ),
        pool.query<{ cash: string }>('SELECT cash::text FROM portfolio_settings WHERE id = $1', [1]),
        pool.query<{
          market_day: string; total_equity: string; total_market_value: string; cash: string
        }>(
          `SELECT market_day::text, total_equity::text, total_market_value::text, cash::text
           FROM portfolio_equity_snapshots ORDER BY market_day`,
        ),
      ])
      return {
        positions: positions.rows.map((row) => ({
          symbol: row.symbol, quantity: row.quantity, averageCost: row.average_cost,
        })),
        cash: cash.rows[0]?.cash ?? '0',
        snapshots: snapshots.rows.map((row) => ({
          marketDay: row.market_day, totalEquity: row.total_equity,
          totalMarketValue: row.total_market_value, cash: row.cash,
        })),
      }
    },
  }
}

export type PortfolioRepository = ReturnType<typeof createPortfolioRepository>

function toPosition(row: PositionRow): ProductPosition {
  return {
    symbol: row.symbol,
    quantity: Number(row.quantity),
    averageCost: Number(row.average_cost),
  }
}
