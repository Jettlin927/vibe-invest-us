import type { ResearchLibraryRepository, ResearchLibraryQuery, ResearchLibraryRecord, ResearchSourceInput } from '@vibe-invest/product-dao'
import { projectResearchView } from './research-export.js'

function reference(record: ResearchLibraryRecord) {
  return { ...record, href: `${record.kind === 'research' ? '/research' : '/conversations'}/${encodeURIComponent(record.id)}` }
}

export function createResearchLibrary({ repository }: { repository: ResearchLibraryRepository}) {
  return {
    async recordSource(threadId: string, detail: {
      record: ResearchLibraryRecord; reportVersions: Array<{id: string; version: number}>
      messages: Array<{sequence: number}>
    }, executionId?: string) {
      const input: ResearchSourceInput = {
        sourceRecordId: detail.record.id, kind: detail.record.kind, title: detail.record.title,
        reportVersions: detail.reportVersions.map(({id,version}) => ({id,version})),
        messageSequences: detail.messages.map(({sequence}) => sequence),
      }
      await repository.recordSource(threadId,input,executionId)
    },
    async listSources(threadId: string) {
      return projectResearchView((await repository.listSources(threadId)).map((source) => ({
        ...source, href: source.available
          ? `${source.kind === 'research' ? '/research' : '/conversations'}/${encodeURIComponent(source.sourceRecordId)}` : null,
      })))
    },
    async search(input: ResearchLibraryQuery = {}) {
      const result = await repository.search(input)
      return projectResearchView({ ...result, items: result.items.map(reference),
        nextOffset: result.offset + result.items.length < result.total ? result.offset + result.items.length : null })
    },
    async read(id: string, offset?: number, limit?: number) {
      const result = await repository.read(id, offset, limit)
      if (!result) return null
      return projectResearchView({ ...result, record: reference(result.record),
        nextOffset: result.offset + result.messages.length < result.total ? result.offset + result.messages.length : null,
        gaps: [
          ...(result.reportVersions.length === 0 ? ['没有已保存的报告版本'] : []),
          ...(result.reportVersions.length === 100 ? ['仅展示最近 100 个报告版本'] : []),
          ...(result.facts.length === 0 ? ['没有可读取的原子事实，报告依据存在缺口'] : []),
          ...(result.total === 0 ? ['没有已封存的用户可见消息'] : []),
          '历史记录未刷新市场事实，请按研究时间判断时效',
        ] })
    },
  }
}
