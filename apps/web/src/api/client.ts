import type { RuntimeSettings } from '@vibe-invest/contracts'

function request(url: string, method?: string, body?: unknown) {
  return fetch(url, method ? {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  } : undefined)
}

const id = encodeURIComponent

export const productApi = {
  health: () => request('/api/health'),
  portfolio: {
    stored: () => request('/api/portfolio/stored'),
    overview: (refresh = false) => request(refresh ? '/api/portfolio?refresh=1' : '/api/portfolio'),
    history: (limit = 30) => request(`/api/portfolio/history?limit=${limit}`),
    events: (limit = 50) => request(`/api/portfolio/events?limit=${limit}`),
    reconcile: (symbol: string, input: { quantity: number; averageCost: number }) => request(`/api/positions/${id(symbol)}`, 'PUT', input),
    remove: (symbol: string) => request(`/api/positions/${id(symbol)}`, 'DELETE'),
    adjustCash: (input: { cash: number }) => request('/api/portfolio/cash', 'PUT', input),
    buy: (symbol: string, input: { quantity: number; price: number }) => request(`/api/positions/${id(symbol)}/buy`, 'POST', input),
    sell: (symbol: string, input: { quantity: number; price: number }) => request(`/api/positions/${id(symbol)}/reduce`, 'POST', input),
    protection: () => request('/api/profit-protection'),
    saveProtection: (symbol: string, input: {
      anchorPrice: number; invalidationPrice: number; coreRatio: number; maxPortfolioWeight: number
      earningsDate: string | null; earningsRiskStartsAt: string | null
    }) => request(`/api/positions/${id(symbol)}/profit-protection`, 'PUT', input),
    acknowledgeProtection: (triggerId: string) => request(`/api/profit-protection/triggers/${id(triggerId)}/acknowledge`, 'POST'),
  },
  research: {
    list: () => request('/api/research'),
    read: (recordId: string, reportVersionId?: string) => request(`/api/research/${id(recordId)}${reportVersionId === undefined ? '' : `?reportVersionId=${id(reportVersionId)}`}`),
    trace: (recordId: string) => request(`/api/research/${id(recordId)}/trace`),
    update: (recordId: string, input: { starred: boolean; note: string }) => request(`/api/research/${id(recordId)}`, 'PATCH', input),
    remove: (recordId: string) => request(`/api/research/${id(recordId)}`, 'DELETE'),
    exportUrl: (recordId: string) => `/api/research/${id(recordId)}/export`,
  },
  analyses: {
    create: (input: { symbol: string }) => request('/api/analyses', 'POST', input),
    read: (analysisId: string) => request(`/api/analyses/${id(analysisId)}`),
    cancel: (analysisId: string) => request(`/api/analyses/${id(analysisId)}/cancel`, 'POST'),
    resume: (analysisId: string) => request(`/api/analyses/${id(analysisId)}/resume`, 'POST'),
    followUp: (analysisId: string, input: { messageId: string; message: string; updateReport: boolean; baseReportVersion?: number }) => request(`/api/analyses/${id(analysisId)}/messages`, 'POST', input),
    events: (sessionId: string, options?: EventSourceInit) => new EventSource(`/api/agent-sessions/${id(sessionId)}/events`, options),
  },
  conversations: {
    list: () => request('/api/conversations'),
    read: (threadId: string) => request(`/api/conversations/${id(threadId)}`),
    create: (input: { message: string; messageId: string }) => request('/api/conversations', 'POST', input),
    send: (threadId: string, input: { message: string; messageId: string }) => request(`/api/conversations/${id(threadId)}/messages`, 'POST', input),
    cancel: (threadId: string) => request(`/api/conversations/${id(threadId)}/cancel`, 'POST'),
    events: (threadId: string, after = 0) => new EventSource(`/api/conversations/${id(threadId)}/events${after > 0 ? `?after=${after}` : ''}`),
  },
  tracking: {
    read: () => request('/api/tracking?limit=100'),
    save: (symbol: string, input: { note: string }) => request(`/api/tracking/watchlist/${id(symbol)}`, 'PUT', input),
    remove: (symbol: string) => request(`/api/tracking/watchlist/${id(symbol)}`, 'DELETE'),
    startScan: () => request('/api/tracking/scans', 'POST'),
    scan: (runId: string) => request(`/api/tracking/scans/${id(runId)}`),
  },
  settings: {
    read: () => request('/api/settings'),
    update: (input: Partial<RuntimeSettings>) => request('/api/settings', 'PUT', input),
    restore: () => request('/api/settings/defaults', 'POST'),
  },
  workbench: {
    pages: () => request('/api/workbench/pages'),
    page: (pageId: string) => request(`/api/workbench/pages/${id(pageId)}`),
    stances: () => request('/api/workbench/stances'),
    save: (input: { operationId: string; id?: string; title: string; blocks: Array<{ type: string; title?: string; symbols?: string[] }> }) => request('/api/workbench/pages', 'POST', input),
    restore: (pageId: string, input: { operationId: string; revision: number }) => request(`/api/workbench/pages/${id(pageId)}/restore`, 'POST', input),
  },
}

export async function readWorkbenchResponse(response: Promise<Response>) {
  const result = await response
  if (!result.ok) throw new Error(`读取或保存失败（${result.status}）`)
  return result.json()
}
