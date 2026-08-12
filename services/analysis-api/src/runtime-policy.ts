export function createConcurrencyGate() {
  let active = 0
  const waiting: Array<() => void> = []
  let currentLimit = Number.POSITIVE_INFINITY
  const wake = () => {
    for (const resume of waiting.splice(0)) resume()
  }
  return {
    setLimit(limit: number) {
      currentLimit = limit
      wake()
    },
    async acquire(signal: AbortSignal) {
      signal.throwIfAborted()
      while (active >= currentLimit) {
        await new Promise<void>((resolve, reject) => {
          let queued = true
          const resume = () => {
            queued = false
            signal.removeEventListener('abort', onAbort)
            resolve()
          }
          const onAbort = () => {
            if (!queued) return
            queued = false
            const index = waiting.indexOf(resume)
            if (index >= 0) waiting.splice(index, 1)
            reject(signal.reason)
          }
          signal.addEventListener('abort', onAbort, { once: true })
          waiting.push(resume)
        })
        signal.throwIfAborted()
      }
      signal.throwIfAborted()
      active += 1
      let released = false
      return () => {
        if (released) return
        released = true
        active -= 1
        wake()
      }
    },
  }
}

export type ActiveBudget = ReturnType<typeof createActiveBudget>

export async function acquireActiveSlot(input: {
  acquire: () => Promise<() => void>
  activeBudget: ActiveBudget
  signal: AbortSignal
  onStart?: () => void
  onEnd?: () => void
}) {
  const release = await input.acquire()
  let active: ReturnType<ActiveBudget['start']> | undefined
  try {
    active = input.activeBudget.start(input.signal)
    input.onStart?.()
  } catch (error) {
    try { active?.stop() } finally { release() }
    throw error
  }
  let finished = false
  return {
    signal: active.signal,
    exhausted: active.exhausted,
    finish() {
      if (finished) return
      finished = true
      try {
        try { input.onEnd?.() } catch { /* logging must not replace the operation outcome */ }
      } finally {
        try { active.stop() } finally { release() }
      }
    },
  }
}

export function createActiveBudget(
  totalMs: number,
  now: () => number = () => performance.now(),
  timeoutSignal: (timeoutMs: number) => AbortSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
) {
  let remainingMs = Math.max(0, totalMs)
  let activeCount = 0
  let activeStartedAt = 0
  let activeTimeout: AbortSignal | undefined
  const currentRemaining = () => Math.max(
    0,
    remainingMs - (activeCount > 0 ? now() - activeStartedAt : 0),
  )
  return {
    start(parent: AbortSignal) {
      if (activeCount === 0) {
        activeStartedAt = now()
        activeTimeout = timeoutSignal(Math.max(1, Math.ceil(remainingMs)))
      }
      const segmentTimeout = activeTimeout!
      activeCount += 1
      let stopped = false
      return {
        signal: AbortSignal.any([parent, segmentTimeout]),
        exhausted: () => segmentTimeout.aborted || currentRemaining() <= 0,
        stop() {
          if (stopped) return
          stopped = true
          const remainingAtStop = currentRemaining()
          activeCount -= 1
          if (activeCount === 0) {
            remainingMs = remainingAtStop
            activeTimeout = undefined
          }
        },
      }
    },
    exhausted: () => activeTimeout?.aborted === true || currentRemaining() <= 0,
    elapsedMs: () => Math.max(0, totalMs - currentRemaining()),
  }
}

export function deadlineSignal(
  parent: AbortSignal | undefined, timeoutMs: number, existingDeadline?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))
  return AbortSignal.any([timeout, ...(parent ? [parent] : []), ...(existingDeadline ? [existingDeadline] : [])])
}
