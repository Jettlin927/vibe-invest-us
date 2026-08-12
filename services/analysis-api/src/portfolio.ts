import type { DatabaseSync } from 'node:sqlite'

type Position = {
  symbol: string
  quantity: number
  averageCost: number
}

type PositionRow = {
  symbol: string
  quantity: number
  average_cost: number
}

export type PortfolioOverview = {
  cash: number
  totalCost: number
  totalMarketValue: number | null
  totalEquity: number | null
  totalUnrealizedProfitLoss: number | null
  totalUnrealizedReturn: number | null
  pricedPositionCount: number
  unpricedPositionCount: number
  positions: Array<Position & {
    costAmount: number
    marketPrice: number | null
    marketValue: number | null
    unrealizedProfitLoss: number | null
    unrealizedReturn: number | null
    portfolioWeight: number | null
  }>
}

export type PortfolioEquitySnapshot = {
  marketDay: string
  totalEquity: number
  totalMarketValue: number
  cash: number
  holdingsCount: number
  pricedCount: number
  observedAt: string
  afterClose: boolean
  dailyChange: number | null
  dailyReturn: number | null
}

type SnapshotRow = {
  market_day: string
  total_equity: number
  total_market_value: number
  cash: number
  holdings_count: number
  priced_count: number
  observed_at: string
  after_close: number
}

export function createPortfolio(database: DatabaseSync) {
  const listStatement = database.prepare(
    'SELECT symbol, quantity, average_cost FROM positions ORDER BY symbol',
  )
  const saveStatement = database.prepare(`
    INSERT INTO positions (symbol, quantity, average_cost, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET
      quantity = excluded.quantity,
      average_cost = excluded.average_cost,
      updated_at = excluded.updated_at
  `)
  const removeStatement = database.prepare('DELETE FROM positions WHERE symbol = ?')
  const readCashStatement = database.prepare('SELECT cash FROM portfolio_settings WHERE id = 1')
  const saveCashStatement = database.prepare('UPDATE portfolio_settings SET cash = ?, updated_at = ? WHERE id = 1')
  const readPositionStatement = database.prepare('SELECT symbol, quantity, average_cost FROM positions WHERE symbol = ?')
  const saveSnapshotStatement = database.prepare(`
    INSERT INTO portfolio_equity_snapshots (
      market_day, total_equity, total_market_value, cash,
      holdings_count, priced_count, observed_at, after_close
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market_day) DO UPDATE SET
      total_equity = excluded.total_equity,
      total_market_value = excluded.total_market_value,
      cash = excluded.cash,
      holdings_count = excluded.holdings_count,
      priced_count = excluded.priced_count,
      observed_at = excluded.observed_at,
      after_close = excluded.after_close
    WHERE portfolio_equity_snapshots.after_close = 0 OR excluded.after_close = 1
  `)
  const listSnapshotsStatement = database.prepare(`
    SELECT market_day, total_equity, total_market_value, cash,
           holdings_count, priced_count, observed_at, after_close
    FROM portfolio_equity_snapshots
    ORDER BY market_day DESC
    LIMIT ?
  `)

  function list(): Position[] {
    return (listStatement.all() as PositionRow[]).map(toPosition)
  }

  return {
    list,
    save(position: Position) {
      saveStatement.run(
        position.symbol,
        position.quantity,
        position.averageCost,
        new Date().toISOString(),
      )
      return position
    },
    remove(symbol: string) {
      removeStatement.run(symbol)
    },
    cash() {
      return Number((readCashStatement.get() as { cash: number }).cash)
    },
    setCash(cash: number) {
      saveCashStatement.run(cash, new Date().toISOString())
      return cash
    },
    reduce(symbol: string, quantity: number, price: number) {
      const row = readPositionStatement.get(symbol) as PositionRow | undefined
      if (!row || quantity > row.quantity) return null
      const remaining = row.quantity - quantity
      const cash = Number((readCashStatement.get() as { cash: number }).cash) + quantity * price
      database.exec('BEGIN IMMEDIATE')
      try {
        if (remaining === 0) removeStatement.run(symbol)
        else saveStatement.run(symbol, remaining, row.average_cost, new Date().toISOString())
        saveCashStatement.run(cash, new Date().toISOString())
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
      return {
        position: remaining === 0 ? null : toPosition({ ...row, quantity: remaining }),
        cash,
        proceeds: quantity * price,
        realizedProfitLoss: (price - row.average_cost) * quantity,
      }
    },
    overview(marketPrices: Record<string, number>): PortfolioOverview {
      const positions = list()
      const cash = Number((readCashStatement.get() as { cash: number }).cash)
      const values = positions.map((position) => {
        const observedPrice = marketPrices[position.symbol]
        const marketPrice = Number.isFinite(observedPrice) && observedPrice! >= 0 ? observedPrice! : null
        const costAmount = position.quantity * position.averageCost
        const marketValue = marketPrice === null ? null : position.quantity * marketPrice
        const unrealizedProfitLoss = marketValue === null ? null : marketValue - costAmount
        return {
          ...position, costAmount,
          marketPrice,
          marketValue,
          unrealizedProfitLoss,
          unrealizedReturn: unrealizedProfitLoss === null || costAmount === 0 ? null : unrealizedProfitLoss / costAmount,
          portfolioWeight: null,
        }
      })
      const priced = values.filter((position) => position.marketValue !== null)
      const totalCost = values.reduce((total, position) => total + position.costAmount, 0)
      const pricedCost = priced.reduce((total, position) => total + position.costAmount, 0)
      const pricedMarketValue = priced.reduce((total, position) => total + position.marketValue!, 0)
      const complete = priced.length === values.length
      const totalMarketValue = complete ? pricedMarketValue : null
      const totalEquity = complete ? pricedMarketValue + cash : null
      const totalUnrealizedProfitLoss = complete
        ? priced.reduce((total, position) => total + position.unrealizedProfitLoss!, 0)
        : null
      return {
        cash, totalCost, totalMarketValue, totalEquity, totalUnrealizedProfitLoss,
        totalUnrealizedReturn: totalUnrealizedProfitLoss === null || pricedCost === 0 ? null : totalUnrealizedProfitLoss / pricedCost,
        pricedPositionCount: priced.length,
        unpricedPositionCount: values.length - priced.length,
        positions: values.map((position) => ({
          ...position,
          portfolioWeight: totalEquity && position.marketValue !== null ? position.marketValue / totalEquity : null,
        })),
      }
    },
    recordSnapshot(overview: PortfolioOverview, observedAt = new Date()) {
      if (overview.totalEquity === null || overview.totalMarketValue === null || overview.positions.length === 0) return false
      const { marketDay, afterClose } = marketTime(observedAt)
      saveSnapshotStatement.run(
        marketDay,
        overview.totalEquity,
        overview.totalMarketValue,
        overview.cash,
        overview.positions.length,
        overview.pricedPositionCount,
        observedAt.toISOString(),
        afterClose ? 1 : 0,
      )
      return true
    },
    history(limit = 30): PortfolioEquitySnapshot[] {
      const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 365)) : 30
      const rows = (listSnapshotsStatement.all(safeLimit) as SnapshotRow[]).reverse()
      return rows.map((row, index) => {
        const previous = rows[index - 1]
        const dailyChange = previous ? row.total_equity - previous.total_equity : null
        return {
          marketDay: row.market_day,
          totalEquity: row.total_equity,
          totalMarketValue: row.total_market_value,
          cash: row.cash,
          holdingsCount: row.holdings_count,
          pricedCount: row.priced_count,
          observedAt: row.observed_at,
          afterClose: row.after_close === 1,
          dailyChange,
          dailyReturn: previous && previous.total_equity !== 0 ? dailyChange! / previous.total_equity : null,
        }
      }).reverse()
    },
    context(symbol: string, marketPrices: Record<string, number>) {
      const positions = list()
      const valuedPositions = positions.flatMap((position) => {
        const marketPrice = marketPrices[position.symbol]
        if (!Number.isFinite(marketPrice) || marketPrice! < 0) return []
        return [{ ...position, marketPrice: marketPrice!, marketValue: position.quantity * marketPrice! }]
      })
      const totalMarketValue = valuedPositions.reduce((total, position) => total + position.marketValue, 0)
      const unpricedPositionCount = positions.length - valuedPositions.length
      const weights = valuedPositions
        .map((position) => totalMarketValue === 0 ? 0 : position.marketValue / totalMarketValue)
        .sort((left, right) => right - left)
      const current = valuedPositions.find((position) => position.symbol === symbol)

      return {
        position: current ? {
          symbol: current.symbol,
          quantity: current.quantity,
          averageCost: current.averageCost,
          marketPrice: current.marketPrice,
          marketValue: current.marketValue,
          unrealizedProfitLoss: current.marketValue - current.quantity * current.averageCost,
          portfolioWeight: unpricedPositionCount > 0 || totalMarketValue === 0
            ? null
            : current.marketValue / totalMarketValue,
        } : null,
        portfolio: {
          totalMarketValue: unpricedPositionCount > 0 ? null : totalMarketValue,
          largestPositionWeight: unpricedPositionCount > 0 ? null : weights[0] ?? 0,
          topThreeWeight: unpricedPositionCount > 0
            ? null
            : weights.slice(0, 3).reduce((total, weight) => total + weight, 0),
          positionCount: positions.length,
          pricedPositionCount: valuedPositions.length,
          unpricedPositionCount,
        },
      }
    },
  }
}

function marketTime(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value)
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return {
    marketDay: `${read('year')}-${read('month')}-${read('day')}`,
    afterClose: Number(read('hour')) * 60 + Number(read('minute')) >= 16 * 60,
  }
}

function toPosition(row: PositionRow): Position {
  return {
    symbol: row.symbol,
    quantity: row.quantity,
    averageCost: row.average_cost,
  }
}

export function normalizeSymbol(value: string) {
  return value.trim().toUpperCase()
}

export function isValidSymbol(symbol: string) {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)
}
