export function parseLastEventId(value: string | undefined, sessionId: string) {
  if (value === undefined) return 0
  const match = value.match(/^(.+):(0|[1-9]\d*)$/)
  if (!match || match[1] !== sessionId) return null
  const sequence = Number(match[2])
  return Number.isSafeInteger(sequence) ? sequence : null
}

export function parseEventSequence(value: string) {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null
  const sequence = Number(value)
  return Number.isSafeInteger(sequence) ? sequence : null
}
