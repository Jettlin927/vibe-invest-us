import { useEffect, useState } from 'react'

type Block = { type: 'positions' | 'stances' | 'watchlist' | 'research'; title?: string; symbols?: string[] }
type SavedPage = { id: string; title: string; blocks: Block[]; revision: number; updatedAt: string }
type Row = { id?: string; symbol: string; quantity?: number; averageCost?: number; note?: string; stance?: string; conditions?: string[]; sourceThreadId?: string | null; sourceRecordId?: string | null; sourceRecordKind?: 'research' | 'conversation' | null; sourceReportVersionId?: string | null; status?: string; updatedAt?: string; createdAt?: string; report?: { title?: string }; sources?: Array<{ href: string; label?: string }> }
const labels = { positions: '持仓', stances: '研究立场', watchlist: '自选', research: '研究记录' }
async function read(url: string, body?: unknown) {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  if (!response.ok) throw new Error(`读取或保存失败（${response.status}）`)
  return response.json()
}

export function WorkbenchPage({ pageId, onOpen }: { pageId?: string; onOpen: (id?: string) => void }) {
  const [pages, setPages] = useState<SavedPage[]>([])
  const [page, setPage] = useState<SavedPage | null>(null)
  const [versions, setVersions] = useState<SavedPage[]>([])
  const [data, setData] = useState<Partial<Record<Block['type'], Row[]>>>({})
  const [gaps, setGaps] = useState<string[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [title, setTitle] = useState('')
  const [blocks, setBlocks] = useState<Block[]>([])
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true); setError(''); setEditing(false); setPage(null)
    void read(pageId ? `/api/workbench/pages/${encodeURIComponent(pageId)}` : '/api/workbench/pages').then((value) => {
      if (!active) return
      if (pageId) { setPage(value.page); setVersions(value.versions) } else setPages(value.pages)
    }).catch((cause) => { if (active) setError(String(cause.message)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [pageId, refresh])
  useEffect(() => {
    if (!page) return
    let active = true
    const types = [...new Set(page.blocks.map((block) => block.type))]
    const endpoints = { positions: ['/api/portfolio/stored', 'positions'], stances: ['/api/workbench/stances', 'stances'], watchlist: ['/api/tracking?limit=100', 'watchlist'], research: ['/api/research', 'records'] }
    setData({}); setGaps([])
    void Promise.all(types.map(async (type) => {
      const [url, field] = endpoints[type]
      try { const value = await read(url); if (active) setData((previous) => ({ ...previous, [type]: value[field] })) }
      catch { if (active) setGaps((previous) => [...previous, labels[type]]) }
    }))
    return () => { active = false }
  }, [page])
  function edit(current?: SavedPage) {
    setTitle(current?.title ?? '我的决策页')
    setBlocks(current?.blocks ?? [{ type: 'positions' }, { type: 'stances' }, { type: 'watchlist' }, { type: 'research' }])
    setEditing(true)
  }
  async function save(revision?: number) {
    if (saving) return
    setSaving(true); setError('')
    try {
      const operationId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('')
      const value = revision !== undefined && page
        ? await read(`/api/workbench/pages/${encodeURIComponent(page.id)}/restore`, { operationId, revision })
        : await read('/api/workbench/pages', { operationId, ...(page ? { id: page.id } : {}), title, blocks: blocks.map((block) => ({ ...block, ...(block.symbols ? { symbols: [...new Set(block.symbols.map((symbol) => symbol.trim()).filter(Boolean))] } : {}) })) })
      setEditing(false)
      if (value.page.id !== pageId) onOpen(value.page.id)
      else setRefresh((value) => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSaving(false) }
  }
  return <div className="workbench-page">
    <header className="page-header"><p className="micro">个人工作台</p><h1>{page?.title ?? '我的页面'}</h1><p>保存你关注的视角。组件在打开或刷新时读取当前数据。</p></header>
    <div className="workbench-actions"><button onClick={() => edit(page ?? undefined)} disabled={loading || saving}>{page ? '编辑页面' : '新建页面'}</button>{page && <><button className="quiet" onClick={() => onOpen()}>全部页面</button><button className="quiet" disabled={saving} onClick={() => setRefresh((value) => value + 1)}>刷新数据</button><span>版本 {page.revision} · {page.updatedAt}</span></>}</div>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">正在读取页面…</p>}
    {editing && <form className="workbench-editor" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <label>页面标题<input value={title} required maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label>
      {blocks.map((block, index) => <fieldset key={index}><legend>组件 {index + 1}</legend><label>组件类型<select value={block.type} onChange={(event) => setBlocks(blocks.map((item, i) => i === index ? { ...item, type: event.target.value as Block['type'] } : item))}>{Object.entries(labels).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></label><label>组件标题<input value={block.title ?? ''} maxLength={200} onChange={(event) => setBlocks(blocks.map((item, i) => i === index ? { ...item, title: event.target.value || undefined } : item))} /></label><label>标的筛选<input placeholder="留空显示全部；如 NVDA, AAPL" value={block.symbols?.join(',') ?? ''} onChange={(event) => setBlocks(blocks.map((item, i) => i === index ? { ...item, symbols: event.target.value.toUpperCase().split(/[,，]/) } : item))} /></label><button type="button" className="quiet" onClick={() => setBlocks(blocks.filter((_, i) => i !== index))}>移除组件 {index + 1}</button></fieldset>)}
      <div className="workbench-actions"><button type="button" className="quiet" disabled={blocks.length >= 20} onClick={() => setBlocks([...blocks, { type: 'research' }])}>添加组件</button><button disabled={saving || blocks.length === 0}>保存页面</button><button type="button" className="quiet" disabled={saving} onClick={() => setEditing(false)}>取消</button></div>
    </form>}
    {!loading && !pageId && !editing && <div className="workbench-grid">{pages.length ? pages.map((item) => <article key={item.id}><a href={`/workbench/${encodeURIComponent(item.id)}`} onClick={(event) => { event.preventDefault(); onOpen(item.id) }}><h2>{item.title}</h2></a><p>{item.blocks.map((block) => labels[block.type]).join(' · ')}</p><small>版本 {item.revision} · {item.updatedAt}</small></article>) : <p>还没有保存的页面。可以新建，也可以在研究对话中描述你需要的页面。</p>}</div>}
    {page && !editing && <><div className="workbench-grid">{page.blocks.map((block, index) => {
      const rows = data[block.type]?.filter((row) => !block.symbols?.length || block.symbols.includes(row.symbol))
      return <section key={index} aria-label={block.title || labels[block.type]}><h2>{block.title || labels[block.type]}</h2>{block.symbols?.length ? <p className="micro">{block.symbols.join(' · ')}</p> : null}{gaps.includes(labels[block.type]) ? <p role="status">{labels[block.type]}读取失败，请刷新重试。</p> : !rows ? <p>正在读取数据…</p> : rows.length === 0 ? <p>暂无匹配记录。</p> : rows.map((row, rowIndex) => <article className="workbench-row" key={row.id ?? `${row.symbol}-${rowIndex}`}><strong>{row.symbol}</strong>{block.type === 'positions' && <p>{row.quantity} 股 · 平均成本 {row.averageCost}</p>}{block.type === 'research' ? <a href={`/research/${encodeURIComponent(row.id!)}`}>{row.report?.title || '查看研究'}</a> : <p>{row.stance ?? row.note}</p>}{block.type === 'stances' && <small>{({ suggested: '模型建议', confirmed: '用户确认', pending: '待确认' } as Record<string, string>)[row.status ?? ''] ?? row.status} · {row.updatedAt}</small>}{row.conditions?.length ? <p>验证条件：{row.conditions.join('；')}</p> : null}{row.sourceThreadId && <a href={`/conversations/${encodeURIComponent(row.sourceThreadId)}`}>来源对话</a>}{row.sourceRecordId && <a href={`/${row.sourceRecordKind === 'conversation' ? 'conversations' : 'research'}/${encodeURIComponent(row.sourceRecordId)}${row.sourceReportVersionId ? `?reportVersionId=${encodeURIComponent(row.sourceReportVersionId)}` : ''}`}>来源记录</a>}{row.sources?.map((source, i) => <a key={i} href={source.href}>{source.label || '查看原文'}</a>)}</article>)}</section>
    })}</div><details className="workbench-history"><summary>历史版本</summary>{versions.map((version) => <div key={version.revision}><span>版本 {version.revision} · {version.title} · {version.updatedAt}</span><button className="quiet" disabled={saving || version.revision === page.revision} onClick={() => void save(version.revision)}>恢复版本 {version.revision}</button></div>)}</details></>}
  </div>
}
