import type { ProfitProtectionPlanRecord, ProfitProtectionStateRecord, ProfitProtectionTriggerRecord } from '@vibe-invest/domain/profit-protection'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { profitProtectionRules, type ProfitProtectionRule } from '@vibe-invest/contracts'

type ProfitProtectionPlanInput = Omit<
  ProfitProtectionPlanRecord,
  'id' | 'revision' | 'earningsDate' | 'earningsRiskStartsAt'
> & {
  earningsDate?: string | null
  earningsRiskStartsAt?: string | null
}

type ProfitProtectionPlanRow = {
  id: string
  symbol: string
  revision: number
  anchor_price: string
  invalidation_price: string
  core_ratio: string
  max_portfolio_weight: string
  planned_quantity: string
  planned_average_cost: string
  earnings_date: string | null
  earnings_risk_starts_at: string | null
  created_at: string
}

function toProfitProtectionPlan(row: ProfitProtectionPlanRow): ProfitProtectionPlanRecord {
  return {
    id: row.id,
    symbol: row.symbol,
    revision: row.revision,
    anchorPrice: Number(row.anchor_price),
    invalidationPrice: Number(row.invalidation_price),
    coreRatio: Number(row.core_ratio),
    maxPortfolioWeight: Number(row.max_portfolio_weight),
    plannedQuantity: Number(row.planned_quantity),
    plannedAverageCost: Number(row.planned_average_cost),
    earningsDate: row.earnings_date,
    earningsRiskStartsAt: row.earnings_risk_starts_at,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

type ProfitProtectionTriggerRow = {
  id: string; event_key: string; symbol: string; plan_id: string; rule: string
  status: 'open' | 'acknowledged'; payload_json: Record<string, unknown>
  triggered_at: string; acknowledged_at: string | null
}

function toProfitProtectionTrigger(row: ProfitProtectionTriggerRow): ProfitProtectionTriggerRecord {
  if (!profitProtectionRules.includes(row.rule as ProfitProtectionRule)) {
    throw new Error('invalid_profit_protection_rule')
  }
  return {
    id: row.id, eventKey: row.event_key, symbol: row.symbol, planId: row.plan_id,
    rule: row.rule as ProfitProtectionRule, status: row.status, payload: row.payload_json,
    triggeredAt: new Date(row.triggered_at).toISOString(),
    acknowledgedAt: row.acknowledged_at ? new Date(row.acknowledged_at).toISOString() : null,
  }
}

export function createProfitProtectionRepository(pool: Pool) {
  const selectPlan = `SELECT id, symbol, revision, anchor_price::text, invalidation_price::text,
    core_ratio::text, max_portfolio_weight::text, planned_quantity::text,
    planned_average_cost::text, earnings_date::text, earnings_risk_starts_at::text, created_at
    FROM profit_protection_plan_versions`
  return {
    async listLatest(): Promise<ProfitProtectionPlanRecord[]> {
      const result = await pool.query<ProfitProtectionPlanRow>(
        `${selectPlan} WHERE (symbol, revision) IN (
          SELECT symbol, max(revision) FROM profit_protection_plan_versions GROUP BY symbol
        ) ORDER BY symbol`,
      )
      return result.rows.map(toProfitProtectionPlan)
    },
    async save(input: ProfitProtectionPlanInput) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.symbol])
        const current = await client.query<{ revision: number }>(
          'SELECT revision FROM profit_protection_plan_versions WHERE symbol = $1 ORDER BY revision DESC LIMIT 1',
          [input.symbol],
        )
        const revision = (current.rows[0]?.revision ?? 0) + 1
        const id = randomUUID()
        const result = await client.query<ProfitProtectionPlanRow>(
          `INSERT INTO profit_protection_plan_versions (
            id, symbol, revision, anchor_price, invalidation_price, core_ratio,
            max_portfolio_weight, planned_quantity, planned_average_cost,
            earnings_date, earnings_risk_starts_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          RETURNING id, symbol, revision, anchor_price::text, invalidation_price::text,
            core_ratio::text, max_portfolio_weight::text, planned_quantity::text,
            planned_average_cost::text, earnings_date::text, earnings_risk_starts_at::text, created_at`,
          [id, input.symbol, revision, String(input.anchorPrice), String(input.invalidationPrice),
            String(input.coreRatio), String(input.maxPortfolioWeight), String(input.plannedQuantity),
            String(input.plannedAverageCost), input.earningsDate ?? null,
            input.earningsRiskStartsAt ?? null,
            input.createdAt],
        )
        await client.query('COMMIT')
        return toProfitProtectionPlan(result.rows[0]!)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async listStates(): Promise<ProfitProtectionStateRecord[]> {
      const result = await pool.query<{
        symbol: string; plan_id: string; peak_price: string; last_price: string
        ema_20: string | null; observed_at: string; updated_at: string
      }>(`SELECT symbol, plan_id, peak_price::text, last_price::text, ema_20::text,
          observed_at, updated_at::text FROM profit_protection_states ORDER BY symbol`)
      return result.rows.map((row) => ({
        symbol: row.symbol, planId: row.plan_id, peakPrice: Number(row.peak_price),
        lastPrice: Number(row.last_price), ema20: row.ema_20 === null ? null : Number(row.ema_20),
        observedAt: row.observed_at, updatedAt: new Date(row.updated_at).toISOString(),
      }))
    },
    async recordEvaluation(input: {
      symbol: string
      state: Omit<ProfitProtectionStateRecord, 'symbol'>
      trigger?: Omit<ProfitProtectionTriggerRecord, 'id' | 'status' | 'acknowledgedAt'>
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO profit_protection_states (
            symbol, plan_id, peak_price, last_price, ema_20, observed_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (symbol) DO UPDATE SET
            plan_id = excluded.plan_id, peak_price = excluded.peak_price,
            last_price = excluded.last_price, ema_20 = excluded.ema_20,
            observed_at = excluded.observed_at, updated_at = excluded.updated_at`,
          [input.symbol, input.state.planId, String(input.state.peakPrice),
            String(input.state.lastPrice), input.state.ema20 === null ? null : String(input.state.ema20),
            input.state.observedAt, input.state.updatedAt],
        )
        if (input.trigger) {
          await client.query(
            `INSERT INTO profit_protection_triggers (
              id, event_key, symbol, plan_id, rule, status, payload_json, triggered_at
            ) VALUES ($1, $2, $3, $4, $5, 'open', $6, $7)
            ON CONFLICT (event_key) DO NOTHING`,
            [randomUUID(), input.trigger.eventKey, input.trigger.symbol, input.trigger.planId,
              input.trigger.rule, JSON.stringify(input.trigger.payload), input.trigger.triggeredAt],
          )
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async listTriggers(): Promise<ProfitProtectionTriggerRecord[]> {
      const result = await pool.query<ProfitProtectionTriggerRow>(
        `SELECT id, event_key, symbol, plan_id, rule, status, payload_json,
          triggered_at::text, acknowledged_at::text
        FROM profit_protection_triggers ORDER BY triggered_at DESC, id DESC`,
      )
      return result.rows.map(toProfitProtectionTrigger)
    },
    async acknowledgeTrigger(id: string, acknowledgedAt: string) {
      const result = await pool.query<ProfitProtectionTriggerRow>(`UPDATE profit_protection_triggers
        SET status = 'acknowledged', acknowledged_at = $2
        WHERE id = $1
        RETURNING id, event_key, symbol, plan_id, rule, status, payload_json,
          triggered_at::text, acknowledged_at::text`, [id, acknowledgedAt])
      const row = result.rows[0]
      return row ? toProfitProtectionTrigger(row) : null
    },
  }
}

export type ProfitProtectionRepository = ReturnType<typeof createProfitProtectionRepository>
