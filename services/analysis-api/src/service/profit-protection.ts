import type { ProfitProtectionRepository } from '@vibe-invest/db'
import { prepareProfitProtectionPlan, evaluateProfitProtection, type ProfitProtectionPosition, type ProfitProtectionSignal } from '@vibe-invest/domain/profit-protection'
export type { ProfitProtectionPosition } from '@vibe-invest/domain/profit-protection'

export function createProfitProtection(repository: ProfitProtectionRepository) {
  return {
    async savePlan(...args: Parameters<typeof prepareProfitProtectionPlan>) {
      return repository.save(prepareProfitProtectionPlan(...args))
    },
    async evaluatePortfolio(input: { positions: ProfitProtectionPosition[]; asOf?: string; signals?: Record<string, ProfitProtectionSignal> }) {
      const [plans, states] = await Promise.all([repository.listLatest(), repository.listStates()])
      return evaluateProfitProtection({ ...input, asOf: input.asOf ?? new Date().toISOString() }, plans, states)
    },
    async observePortfolio(input: {
      positions: ProfitProtectionPosition[]
      asOf?: string
      signals: Record<string, ProfitProtectionSignal>
    }) {
      const evaluated = await this.evaluatePortfolio(input)
      const plans = new Map((await repository.listLatest()).map((plan) => [plan.symbol, plan]))
      const updatedAt = new Date().toISOString()
      await Promise.all(evaluated.flatMap((status) => {
        const plan = plans.get(status.symbol)
        const signal = input.signals[status.symbol]
        if (!plan || !signal || status.marketPrice === null) return []
        const peakPrice = status.trailing?.peakPrice
          ?? Math.max(signal.peakPrice ?? status.marketPrice, status.marketPrice)
        return [repository.recordEvaluation({
          symbol: status.symbol,
          state: {
            planId: plan.id, peakPrice, lastPrice: status.marketPrice,
            ema20: signal.ema20, observedAt: signal.observedAt, updatedAt,
          },
          ...(status.bindingRule ? {
            trigger: {
              eventKey: `${plan.id}:${status.bindingRule}`,
              symbol: status.symbol, planId: plan.id, rule: status.bindingRule,
              payload: {
                currentR: status.currentR, marketPrice: status.marketPrice,
                peakPrice, ema20: signal.ema20,
              },
              triggeredAt: signal.observedAt,
            },
          } : {}),
        })]
      }))
      return evaluated
    },
    listTriggers() {
      return repository.listTriggers()
    },
    acknowledgeTrigger(id: string, acknowledgedAt: string) {
      return repository.acknowledgeTrigger(id, acknowledgedAt)
    },
  }
}
