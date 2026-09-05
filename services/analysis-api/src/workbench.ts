import type { WorkbenchRepository, WorkbenchBlock } from '@vibe-invest/product-dao'

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('invalid_workbench_input')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('invalid_workbench_text')
  return value.trim()
}
function symbol(value: unknown): string {
  const result = text(value, 20).toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9.^-]*$/.test(result)) throw new Error('invalid_workbench_symbol')
  return result
}
function strings(value: unknown, maxCount: number, parse: (value: unknown) => string): string[] {
  if (!Array.isArray(value) || value.length > maxCount) throw new Error('invalid_workbench_list')
  return value.map(parse)
}

export function createWorkbench(repository: WorkbenchRepository) {
  return {
    listStances: (filter?: string) => repository.listStances(filter === undefined ? undefined : symbol(filter)),
    listPages: () => repository.listPages(),
    getPage: (id: string) => repository.getPage(text(id, 100)),
    async saveStance(value: unknown, executionId?: string) {
      const input = record(value, ['operationId', 'symbol', 'stance', 'status', 'conditions', 'sourceThreadId', 'sourceRecordId', 'sourceReportVersionId'])
      if (input.status !== 'suggested' && input.status !== 'confirmed' && input.status !== 'pending') throw new Error('invalid_workbench_status')
      return repository.saveStance({
        operationId: text(input.operationId, 200), symbol: symbol(input.symbol), stance: text(input.stance, 4000),
        status: input.status, conditions: strings(input.conditions ?? [], 30, (item) => text(item, 1000)),
        sourceThreadId: input.sourceThreadId == null ? null : text(input.sourceThreadId, 100),
        sourceRecordId: input.sourceRecordId == null ? null : text(input.sourceRecordId, 100),
        sourceReportVersionId: input.sourceReportVersionId == null ? null : text(input.sourceReportVersionId, 100),
      }, executionId)
    },
    async savePage(value: unknown, executionId?: string) {
      const input = record(value, ['operationId', 'id', 'title', 'blocks'])
      if (!Array.isArray(input.blocks) || input.blocks.length < 1 || input.blocks.length > 20) throw new Error('invalid_workbench_blocks')
      const blocks: WorkbenchBlock[] = input.blocks.map((value) => {
        const block = record(value, ['type', 'title', 'symbols'])
        if (block.type !== 'positions' && block.type !== 'stances' && block.type !== 'watchlist' && block.type !== 'research') throw new Error('invalid_workbench_block_type')
        return { type: block.type, ...(block.title === undefined ? {} : { title: text(block.title, 200) }), ...(block.symbols === undefined ? {} : { symbols: strings(block.symbols, 100, symbol) }) }
      })
      return repository.savePage({ operationId: text(input.operationId, 200), ...(input.id === undefined ? {} : { id: text(input.id, 100) }), title: text(input.title, 200), blocks }, executionId)
    },
    async restorePage(value: unknown, executionId?: string) {
      const input = record(value, ['operationId', 'id', 'revision'])
      if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('invalid_workbench_revision')
      return repository.restorePage({ operationId: text(input.operationId, 200), id: text(input.id, 100), revision: input.revision }, executionId)
    },
  }
}
