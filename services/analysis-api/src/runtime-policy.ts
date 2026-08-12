export function createConcurrencyGate() {
  let active = 0
  const waiting: Array<() => void> = []
  const wake = () => waiting.shift()?.()
  return {
    async acquire(limit: number, signal: AbortSignal) {
      signal.throwIfAborted()
      while (active >= limit) {
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

export function createActiveBudget(totalMs: number) {
  let remainingMs = Math.max(0, totalMs)
  return {
    start(parent: AbortSignal) {
      const startedAt = performance.now()
      const activeTimeout = AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs)))
      let stopped = false
      return {
        signal: AbortSignal.any([parent, activeTimeout]),
        exhausted: () => activeTimeout.aborted || remainingMs <= 0,
        stop() {
          if (stopped) return
          stopped = true
          remainingMs = Math.max(0, remainingMs - (performance.now() - startedAt))
        },
      }
    },
    exhausted: () => remainingMs <= 0,
    elapsedMs: () => Math.max(0, totalMs - remainingMs),
  }
}

export function deadlineSignal(
  parent: AbortSignal | undefined, timeoutMs: number, existingDeadline?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))
  return AbortSignal.any([timeout, ...(parent ? [parent] : []), ...(existingDeadline ? [existingDeadline] : [])])
}
