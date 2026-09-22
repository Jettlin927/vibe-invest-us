
export function jsonValuesEqual(left: unknown, right: unknown) {
  return canonicalizeJson(left) === canonicalizeJson(right)
}

export function nullableInstantsEqual(left: string | null, right: string | null) {
  return left === null || right === null ? left === right : sameInstant(left, right)
}

export function sameInstant(left: string | null, right: string) {
  return left !== null && new Date(left).getTime() === new Date(right).getTime()
}

function canonicalizeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
