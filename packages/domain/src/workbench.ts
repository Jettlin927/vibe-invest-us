export type StanceRecord = {
  id: string; symbol: string; revision: number; stance: string
  status: 'suggested' | 'confirmed' | 'pending'; conditions: string[]
  sourceThreadId: string | null; sourceRecordId: string | null; updatedAt: string
  sourceRecordKind: 'research' | 'conversation' | null; sourceReportVersionId: string | null
}
export type WorkbenchBlock = {
  type: 'positions' | 'stances' | 'watchlist' | 'research'; title?: string; symbols?: string[]
}
export type WorkbenchPage = { id: string; revision: number; title: string; blocks: WorkbenchBlock[]; updatedAt: string }
export type SaveStanceInput = Omit<StanceRecord, 'id' | 'revision' | 'updatedAt' | 'sourceRecordKind' | 'sourceReportVersionId'> & { operationId: string; sourceReportVersionId?: string | null }
export type SavePageInput = Pick<WorkbenchPage, 'title' | 'blocks'> & { id?: string; operationId: string }
export type RestorePageInput = { id: string; revision: number; operationId: string }

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('invalid_workbench_input')
  return value as Record<string, unknown>
}
export function workbenchText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('invalid_workbench_text')
  return value.trim()
}
export function workbenchSymbol(value: unknown): string {
  const result = workbenchText(value, 20).toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9.^-]*$/.test(result)) throw new Error('invalid_workbench_symbol')
  return result
}
function strings(value: unknown, maxCount: number, parse: (value: unknown) => string): string[] {
  if (!Array.isArray(value) || value.length > maxCount) throw new Error('invalid_workbench_list')
  return value.map(parse)
}

export function parseSaveStance(value: unknown): SaveStanceInput {
  const input = record(value, ['operationId', 'symbol', 'stance', 'status', 'conditions', 'sourceThreadId', 'sourceRecordId', 'sourceReportVersionId'])
  if (input.status !== 'suggested' && input.status !== 'confirmed' && input.status !== 'pending') throw new Error('invalid_workbench_status')
  return {
    operationId: workbenchText(input.operationId, 200), symbol: workbenchSymbol(input.symbol), stance: workbenchText(input.stance, 4000),
    status: input.status, conditions: strings(input.conditions ?? [], 30, (item) => workbenchText(item, 1000)),
    sourceThreadId: input.sourceThreadId == null ? null : workbenchText(input.sourceThreadId, 100),
    sourceRecordId: input.sourceRecordId == null ? null : workbenchText(input.sourceRecordId, 100),
    sourceReportVersionId: input.sourceReportVersionId == null ? null : workbenchText(input.sourceReportVersionId, 100),
  }
}

export function parseSavePage(value: unknown): SavePageInput {
  const input = record(value, ['operationId', 'id', 'title', 'blocks'])
  if (!Array.isArray(input.blocks) || input.blocks.length < 1 || input.blocks.length > 20) throw new Error('invalid_workbench_blocks')
  const blocks: WorkbenchBlock[] = input.blocks.map((value) => {
    const block = record(value, ['type', 'title', 'symbols'])
    if (block.type !== 'positions' && block.type !== 'stances' && block.type !== 'watchlist' && block.type !== 'research') throw new Error('invalid_workbench_block_type')
    return { type: block.type, ...(block.title === undefined ? {} : { title: workbenchText(block.title, 200) }), ...(block.symbols === undefined ? {} : { symbols: strings(block.symbols, 100, workbenchSymbol) }) }
  })
  return { operationId: workbenchText(input.operationId, 200), ...(input.id === undefined ? {} : { id: workbenchText(input.id, 100) }), title: workbenchText(input.title, 200), blocks }
}

export function parseRestorePage(value: unknown): RestorePageInput {
  const input = record(value, ['operationId', 'id', 'revision'])
  if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('invalid_workbench_revision')
  return { operationId: workbenchText(input.operationId, 200), id: workbenchText(input.id, 100), revision: input.revision }
}
