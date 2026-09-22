import type { ProfitProtectionRule } from '@vibe-invest/contracts'
export type ProfitProtectionPlanRecord = {
  id: string
  symbol: string
  revision: number
  anchorPrice: number
  invalidationPrice: number
  coreRatio: number
  maxPortfolioWeight: number
  plannedQuantity: number
  plannedAverageCost: number
  earningsDate: string | null
  earningsRiskStartsAt: string | null
  createdAt: string
}

export type ProfitProtectionStateRecord = {
  symbol: string
  planId: string
  peakPrice: number
  lastPrice: number
  ema20: number | null
  observedAt: string
  updatedAt: string
}

export type ProfitProtectionTriggerRecord = {
  id: string
  eventKey: string
  symbol: string
  planId: string
  rule: ProfitProtectionRule
  status: 'open' | 'acknowledged'
  payload: Record<string, unknown>
  triggeredAt: string
  acknowledgedAt: string | null
}

export type ProfitProtectionPosition = {
  symbol: string
  quantity: number
  averageCost: number
  marketPrice: number | null
  portfolioWeight: number | null
}

type BindingRule = ProfitProtectionRule | null

export type ProfitProtectionSignal = {
  ema20: number | null
  peakPrice: number | null
  observedAt: string
}

type ProfitProtectionPlan = ProfitProtectionPlanRecord
export type ProfitProtectionInput = {
  positions: ProfitProtectionPosition[]
  asOf: string
  signals?: Record<string, ProfitProtectionSignal>
}
export function prepareProfitProtectionPlan(
  input: Pick<ProfitProtectionPlan, 'symbol' | 'anchorPrice' | 'invalidationPrice' | 'coreRatio' | 'maxPortfolioWeight'>
    & Partial<Pick<ProfitProtectionPlan, 'earningsDate' | 'earningsRiskStartsAt'>>,
  position: Pick<ProfitProtectionPosition, 'symbol' | 'quantity' | 'averageCost'>,
  createdAt: string,
) {
  if (input.symbol !== position.symbol) throw new Error('profit_protection_position_mismatch')
  const earningsDate = input.earningsDate ?? null
  const earningsRiskStartsAt = input.earningsRiskStartsAt ?? null
  const validDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
  }
  if (
    !Number.isFinite(input.anchorPrice) || input.anchorPrice <= 0
    || !Number.isFinite(input.invalidationPrice) || input.invalidationPrice < 0
    || input.invalidationPrice >= input.anchorPrice
    || !Number.isFinite(input.coreRatio) || input.coreRatio <= 0 || input.coreRatio >= 1
    || !Number.isFinite(input.maxPortfolioWeight)
    || input.maxPortfolioWeight <= 0 || input.maxPortfolioWeight > 1
    || Boolean(earningsDate) !== Boolean(earningsRiskStartsAt)
    || (earningsDate !== null && (!validDate(earningsDate)
      || !validDate(earningsRiskStartsAt!) || earningsRiskStartsAt! > earningsDate))
  ) throw new Error('invalid_profit_protection_plan')
  return {
    ...input,
    earningsDate,
    earningsRiskStartsAt,
    plannedQuantity: position.quantity,
    plannedAverageCost: position.averageCost,
    createdAt,
  }
}
export function evaluateProfitProtection(
  input: ProfitProtectionInput, planRecords: ProfitProtectionPlanRecord[], stateRecords: ProfitProtectionStateRecord[],
) {
  const plans = new Map(planRecords.map((plan) => [plan.symbol, plan]))
  const states = new Map(stateRecords.map((state) => [state.symbol, state]))
  return input.positions.flatMap((position) => {
    const plan = plans.get(position.symbol)
    if (!plan) return []
    const risk = plan.anchorPrice - plan.invalidationPrice
    const currentR = position.marketPrice === null ? null : (position.marketPrice - plan.anchorPrice) / risk
    const positionChanged = position.quantity !== plan.plannedQuantity
      || Math.abs(position.averageCost - plan.plannedAverageCost) > 1e-9
    const asOf = marketDate(input.asOf)
    const inEarningsWindow = plan.earningsDate !== null
      && plan.earningsRiskStartsAt !== null
      && asOf >= plan.earningsRiskStartsAt && asOf <= plan.earningsDate
    const storedState = states.get(position.symbol)
    const suppliedSignal = input.signals?.[position.symbol]
    const signal = suppliedSignal ? {
      ...suppliedSignal,
      peakPrice: storedState?.planId === plan.id
        ? Math.max(suppliedSignal.peakPrice ?? 0, storedState.peakPrice)
        : suppliedSignal.peakPrice,
    } : storedState?.planId === plan.id ? {
      ema20: storedState.ema20,
      peakPrice: storedState.peakPrice,
      observedAt: storedState.observedAt,
    } : undefined
    const peakPrice = signal?.peakPrice === null || signal?.peakPrice === undefined
      ? position.marketPrice
      : position.marketPrice === null ? signal.peakPrice : Math.max(signal.peakPrice, position.marketPrice)
    const peakR = peakPrice === null ? null : (peakPrice - plan.anchorPrice) / risk
    const trailingActive = peakR !== null && peakR >= 4
    let bindingRule: BindingRule = null
    if (position.marketPrice !== null && position.marketPrice <= plan.invalidationPrice) {
      bindingRule = 'thesis_invalidation'
    } else if (positionChanged) {
      bindingRule = 'position_changed'
    } else if (inEarningsWindow) {
      bindingRule = 'earnings_window'
    } else if (trailingActive && position.marketPrice !== null
      && signal?.ema20 !== null && signal?.ema20 !== undefined
      && position.marketPrice < signal.ema20) {
      bindingRule = 'trailing_stop'
    } else if (position.portfolioWeight !== null
      && position.portfolioWeight > plan.maxPortfolioWeight) {
      bindingRule = 'max_weight'
    } else if (currentR !== null && currentR >= 4) {
      bindingRule = 'activate_trailing'
    } else if (currentR !== null && currentR >= 3) {
      bindingRule = 'second_take_profit'
    } else if (currentR !== null && currentR >= 2) {
      bindingRule = 'first_take_profit'
    }
    return [{
      symbol: position.symbol,
      status: bindingRule === 'position_changed'
        ? 'review_required'
        : position.marketPrice === null ? 'data_gap' : bindingRule ? 'triggered' : 'normal',
      planRevision: plan.revision,
      currentR,
      bindingRule,
      nextRule: bindingRule === 'thesis_invalidation' || bindingRule === 'position_changed'
        || bindingRule === 'earnings_window'
        || bindingRule === 'max_weight'
        || bindingRule === 'activate_trailing' || bindingRule === 'trailing_stop'
        ? null
        : bindingRule === 'second_take_profit'
          ? { kind: 'activate_trailing', atR: 4 }
          : bindingRule === 'first_take_profit'
            ? { kind: 'second_take_profit', atR: 3 }
            : { kind: 'first_take_profit', atR: 2 },
      coreRatio: plan.coreRatio,
      tradingRatio: 1 - plan.coreRatio,
      anchorPrice: plan.anchorPrice,
      invalidationPrice: plan.invalidationPrice,
      maxPortfolioWeight: plan.maxPortfolioWeight,
      marketPrice: position.marketPrice,
      portfolioWeight: position.portfolioWeight,
      levels: {
        firstTakeProfit: plan.anchorPrice + risk * 2,
        secondTakeProfit: plan.anchorPrice + risk * 3,
        trailingStart: plan.anchorPrice + risk * 4,
      },
      ...(plan.earningsDate && plan.earningsRiskStartsAt ? {
        earnings: {
          date: plan.earningsDate,
          riskStartsAt: plan.earningsRiskStartsAt,
          inRiskWindow: inEarningsWindow,
        },
      } : {}),
      ...(signal ? {
        trailing: {
          active: trailingActive,
          ema20: signal.ema20,
          observedAt: signal.observedAt,
          peakPrice,
        },
      } : {}),
      ...(signal && !positionChanged && peakPrice !== null && position.marketPrice !== null ? {
        profitJourney: profitJourney(
          plan.plannedAverageCost, position.quantity, peakPrice, position.marketPrice,
        ),
      } : {}),
    }]
  })
}

function profitJourney(averageCost: number, quantity: number, peakPrice: number, currentPrice: number) {
  const peakUnrealizedProfit = (peakPrice - averageCost) * quantity
  const currentUnrealizedProfit = (currentPrice - averageCost) * quantity
  const givebackAmount = Math.max(0, peakUnrealizedProfit - currentUnrealizedProfit)
  return {
    peakUnrealizedProfit,
    currentUnrealizedProfit,
    givebackAmount,
    givebackRatio: peakUnrealizedProfit > 0 ? givebackAmount / peakUnrealizedProfit : null,
  }
}

function marketDate(value: string) {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const date = new Date(value)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}
