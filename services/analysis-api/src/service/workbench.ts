import type { WorkbenchRepository } from '@vibe-invest/db'
import { workbenchText, workbenchSymbol, parseSaveStance, parseSavePage, parseRestorePage } from '@vibe-invest/domain/workbench'

export function createWorkbench(repository: WorkbenchRepository) {
  return {
    listStances: (filter?: string) => repository.listStances(filter === undefined ? undefined : workbenchSymbol(filter)),
    listPages: () => repository.listPages(),
    getPage: (id: string) => repository.getPage(workbenchText(id, 100)),
    saveStance: async (value: unknown, executionId?: string) => repository.saveStance(parseSaveStance(value), executionId),
    savePage: async (value: unknown, executionId?: string) => repository.savePage(parseSavePage(value), executionId),
    restorePage: async (value: unknown, executionId?: string) => repository.restorePage(parseRestorePage(value), executionId),
  }
}
