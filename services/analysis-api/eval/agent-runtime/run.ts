import { parseArgs } from 'node:util'
import { resolve } from 'node:path'

import { createPiModel, type ModelEvent, type ModelOptions } from '../../src/service/agent-runtime/model.js'
import type { RuntimeSettings } from '@vibe-invest/contracts'
import { createEvalRuntime } from './harness/app.js'
import { createFixtureWorld, type FixtureOptions, type FixtureWorld } from './harness/fixture.js'
import {
  collectAnalysisObservation, collectConversationObservation,
  waitForAnalysisTerminal, waitForThreadTerminal,
} from './harness/observe.js'
import type { EvalCase, EvalCheckResult, EvalMode, EvalObservation } from './types.js'
import { cases } from './cases/index.js'

type RunResult = {
  case: EvalCase
  mode: EvalMode
  observation?: EvalObservation
  checks: EvalCheckResult[]
  error?: string
}

const help = `Agent Runtime Eval

Usage: npm run eval:agent-runtime -- [options]

Options:
  --mode=fixture|live|all   Run deterministic fixture evals and/or live-model evals (default: fixture)
  --case=<id>               Run one case by id
  --repeat=<n>              Repeat each case n times; default 1. Live mode reports pass@k per check
  --timeout-ms=<n>          Per-analysis wait timeout (default 120000)
  --json=<path>             Write machine-readable result JSON
  --help                    Show this help

Live model variables: MODEL_PROVIDER, MODEL_API_PROTOCOL, MODEL_NAME,
MODEL_BASE_URL, MODEL_API_KEY, MODEL_CONTEXT_WINDOW
`

function liveModelOptions(): ModelOptions | null {
  const provider = process.env.MODEL_PROVIDER
  const apiProtocol = process.env.MODEL_API_PROTOCOL
  const modelName = process.env.MODEL_NAME
  const baseUrl = process.env.MODEL_BASE_URL
  const apiKey = process.env.MODEL_API_KEY
  const contextWindow = Number(process.env.MODEL_CONTEXT_WINDOW ?? process.env.EVAL_MODEL_CONTEXT_WINDOW)
  if (provider && (apiProtocol === 'chat-completions' || apiProtocol === 'responses')
    && modelName && baseUrl && apiKey && Number.isInteger(contextWindow) && contextWindow > 0) {
    return { provider, apiProtocol, modelName, baseUrl, apiKey, contextWindow }
  }
  return null
}

function recordModel(model: ReturnType<typeof createPiModel>, events: ModelEvent[]) {
  const record = (method: (...args: any[]) => AsyncIterable<ModelEvent>) => async function* (
    ...args: any[]
  ): AsyncIterable<ModelEvent> {
    for await (const event of method(...args)) {
      events.push(event)
      yield event
    }
  }
  return {
    analyze: record(model.analyze.bind(model)),
    analyzeConversation: model.analyzeConversation
      ? record(model.analyzeConversation.bind(model)) : undefined,
    analyzeNews: model.analyzeNews ? record(model.analyzeNews.bind(model)) : undefined,
    analyzeFundamental: model.analyzeFundamental
      ? record(model.analyzeFundamental.bind(model)) : undefined,
    analyzeTechnical: model.analyzeTechnical
      ? record(model.analyzeTechnical.bind(model)) : undefined,
  }
}

function fixtureOptions(caseSpec: EvalCase): FixtureOptions {
  return (caseSpec.fixtureOptions ?? {}) as unknown as FixtureOptions
}

async function runOnce(input: {
  evalCase: EvalCase
  mode: EvalMode
  timeoutMs: number
  liveOptions: ModelOptions | null
}): Promise<RunResult> {
  const { evalCase, mode } = input
  const fixture = createFixtureWorld(fixtureOptions(evalCase))
  const modelEvents: ModelEvent[] = []
  const modelLog: Array<Record<string, unknown>> = []
  const log = (entry: Record<string, unknown>) => { modelLog.push(entry) }

  if (mode === 'live' && input.liveOptions === null) {
    return { case: evalCase, mode, checks: [], error: 'live_model_not_configured' }
  }
  let options: ModelOptions
  if (mode === 'fixture') {
    if (evalCase.modelScript === undefined) {
      return { case: evalCase, mode, checks: [], error: 'fixture_script_missing' }
    }
    options = {
      ...evalCase.modelOptions,
      contextWindow: evalCase.modelOptions?.contextWindow ?? 64_000,
      fauxResponses: evalCase.modelScript(fixture),
      log,
    }
  } else {
    options = {
      ...evalCase.modelOptions,
      ...input.liveOptions,
      log,
    }
  }
  const model = recordModel(createPiModel(options), modelEvents)
  const runtime = await createEvalRuntime({
    model,
    fixture,
    settings: evalCase.settings as Partial<RuntimeSettings> | undefined,
    runtimeMinuteMs: evalCase.modelOptions?.runtimeMinuteMs,
  })
  const startedAt = Date.now()
  let analysisId: string | undefined
  let threadId: string | undefined
  let error: string | undefined
  try {
    const outcome = await evalCase.run({
      mode,
      fixture,
      app: runtime.app,
      database: runtime.database as never,
      modelEvents,
      modelLog,
      waitForAnalysisTerminal: (id, timeout) => waitForAnalysisTerminal(runtime.app, id, timeout ?? input.timeoutMs),
      waitForThreadTerminal: (id, timeout) => waitForThreadTerminal(runtime.app, id, timeout ?? input.timeoutMs),
    })
    analysisId = outcome.analysisId
    threadId = outcome.threadId
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
  } finally {
    if (error && analysisId) {
      await runtime.app.inject({ method: 'POST', url: `/api/analyses/${analysisId}/cancel` }).catch(() => undefined)
    }
  }
  try {
    let observation: EvalObservation
    if (evalCase.target === 'conversation') {
      if (threadId === undefined) throw new Error('conversation_id_missing')
      observation = await collectConversationObservation({
        mode, caseId: evalCase.id, title: evalCase.title, threadId,
        app: runtime.app, database: runtime.database as never,
        fixtureCalls: fixture.calls as unknown as Array<Record<string, unknown>>,
        modelEvents, startedAt, ...(error === undefined ? {} : { error }),
      })
    } else {
      if (analysisId === undefined) throw new Error('analysis_id_missing')
      observation = await collectAnalysisObservation({
        mode, caseId: evalCase.id, title: evalCase.title, analysisId,
        app: runtime.app, database: runtime.database as never,
        fixtureCalls: fixture.calls as unknown as Array<Record<string, unknown>>,
        modelEvents, startedAt, ...(error === undefined ? {} : { error }),
      })
    }
    const checks = await Promise.all(evalCase.checks.map((check) => check(observation)))
    return { case: evalCase, mode, observation, checks, ...(error === undefined ? {} : { error }) }
  } catch (caught) {
    const message = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
    return { case: evalCase, mode, checks: [], error }
  } finally {
    await runtime.close()
  }
}

function decideChecks(results: RunResult[]): Array<{ id: string; description: string; pass: number; fail: number; detail: string[] }> {
  const map = new Map<string, { id: string; description: string; pass: number; fail: number; detail: string[] }>()
  for (const result of results) {
    for (const check of result.checks) {
      const current = map.get(check.id) ?? {
        id: check.id, description: check.description, pass: 0, fail: 0, detail: [],
      }
      if (check.status === 'pass') current.pass += 1
      if (check.status === 'fail') {
        current.fail += 1
        if (check.detail) current.detail.push(check.detail)
      }
      map.set(check.id, current)
    }
  }
  return [...map.values()]
}

async function main() {
  try { process.loadEnvFile(resolve(import.meta.dirname, '../../../../../.env')) } catch { /* root .env is optional */ }
  const args = parseArgs({ options: {
    mode: { type: 'string' }, case: { type: 'string' }, repeat: { type: 'string' },
    'timeout-ms': { type: 'string' }, json: { type: 'string' }, help: { type: 'boolean' },
  }, allowPositionals: false }).values
  if (args.help) {
    console.log(help)
    return
  }
  const mode = (args.mode ?? 'fixture') as 'fixture' | 'live' | 'all'
  const repeat = Math.max(1, Number(args.repeat ?? 1))
  const timeoutMs = Number(args['timeout-ms'] ?? 120_000)
  const selected = args.case ? cases.filter(({ id }) => id === args.case) : cases
  if (selected.length === 0) {
    console.error(`unknown case: ${args.case}`)
    process.exitCode = 2
    return
  }
  const modes: EvalMode[] = mode === 'all' ? ['fixture', 'live'] : [mode]
  const liveOptions = liveModelOptions()
  const results: RunResult[] = []
  let skipped = 0
  for (const evalCase of selected) {
    for (const currentMode of modes) {
      if (evalCase.modes.includes(currentMode) === false) continue
      for (let index = 0; index < repeat; index += 1) {
        const result = await runOnce({ evalCase, mode: currentMode, timeoutMs, liveOptions })
        if (result.error === 'live_model_not_configured') {
          skipped += 1
          console.log(`[SKIP] ${evalCase.id} (${currentMode}) live model not configured`)
          continue
        }
        results.push(result)
        const passed = result.checks.filter((check) => check.status === 'pass').length
        const failed = result.checks.filter((check) => check.status === 'fail').length
        const mark = result.error ? 'ERROR' : failed > 0 ? 'FAIL' : 'PASS'
        const suffix = result.observation
          ? ` tools=${result.observation.stats.toolCalls} rounds=${result.observation.stats.toolRounds} ` +
            `tokens=${result.observation.stats.totalTokens ?? 'n/a'} ` +
            `specialists=${result.observation.stats.specialistSessions} ` +
            `${result.observation.stats.durationMs}ms`
          : ''
        console.log(`[${mark}] ${evalCase.id} (${currentMode}) ${passed}/${passed + failed} checks${suffix}`)
        if (result.error) console.log(`       error: ${result.error}`)
        for (const check of result.checks.filter((item) => item.status === 'fail')) {
          console.log(`       FAIL ${check.id}: ${check.description}${check.detail ? ` (${check.detail})` : ''}`)
        }
      }
    }
  }
  const summary = decideChecks(results)
  console.log('\nSummary:')
  if (skipped > 0) console.log(`  skipped=${skipped} (live model not configured)`)
  for (const item of summary) {
    console.log(`  ${item.pass}/${item.pass + item.fail} ${item.id} - ${item.description}${item.detail.length ? ` [${item.detail.slice(0, 3).join('; ')}]` : ''}`)
  }
  const observed = results.flatMap((result) => result.observation ? [result.observation] : [])
  if (observed.length > 0) {
    const average = (values: Array<number | null>) => {
      const present = values.filter((value): value is number => typeof value === 'number')
      return present.length === 0 ? null : present.reduce((total, value) => total + value, 0) / present.length
    }
    console.log('\nMetrics (average per run):')
    console.log(`  durationMs=${average(observed.map(({ stats }) => stats.durationMs)) ?? 'n/a'} ` +
      `toolCalls=${average(observed.map(({ stats }) => stats.toolCalls)) ?? 'n/a'} ` +
      `toolRounds=${average(observed.map(({ stats }) => stats.toolRounds)) ?? 'n/a'} ` +
      `specialists=${average(observed.map(({ stats }) => stats.specialistSessions)) ?? 'n/a'} ` +
      `compactions=${average(observed.map(({ stats }) => stats.compactions)) ?? 'n/a'}`)
    console.log(`  totalTokens=${average(observed.map(({ stats }) => stats.totalTokens)) ?? 'n/a'} ` +
      `inputTokens=${average(observed.map(({ stats }) => stats.inputTokens)) ?? 'n/a'} ` +
      `outputTokens=${average(observed.map(({ stats }) => stats.outputTokens)) ?? 'n/a'} ` +
      `cachedInputTokens=${average(observed.map(({ stats }) => stats.cachedInputTokens)) ?? 'n/a'}`)
  }
  if (args.json) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(args.json, JSON.stringify({ mode, repeat, results }, null, 2))
    console.log(`\nJSON report written to ${args.json}`)
  }
  const hardFailures = results.filter((result) => result.error !== undefined
    || result.checks.some((check) => check.status === 'fail'))
  process.exitCode = hardFailures.length > 0 ? 1 : 0
}

await main()
