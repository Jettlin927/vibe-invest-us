import { useId, useState, type ReactNode } from 'react'

export function useDisclosure(name: string, defaultOpen = true) {
  const key = `vibe-invest:disclosure:${name}`
  const [open, setOpen] = useState(() => {
    try {
      const saved = window.localStorage.getItem(key)
      return saved === null ? defaultOpen : saved === 'true'
    } catch { return defaultOpen }
  })
  function toggle() {
    const next = !open
    setOpen(next)
    try { window.localStorage.setItem(key, String(next)) } catch { /* 浏览器禁止存储时仍可折叠。 */ }
  }
  return { open, toggle }
}

export function DisclosureSection({ name, title, eyebrow, className = '', summary, actions, defaultOpen = true, children }: {
  name: string; title: string; eyebrow?: string; className?: string
  summary?: ReactNode; actions?: ReactNode; defaultOpen?: boolean; children: ReactNode
}) {
  const { open, toggle } = useDisclosure(name, defaultOpen)
  const bodyId = useId()
  return <section className={`${className} disclosure-section`}>
    <header className="disclosure-header"><div>{eyebrow && <p className="micro">{eyebrow}</p>}<h2>{title}</h2></div>
      <div className="disclosure-actions">{actions}<button type="button" className="quiet" aria-label={`${open ? '收起' : '展开'}${title}`} aria-expanded={open} aria-controls={bodyId} onClick={toggle}>{open ? '收起' : '展开'}</button></div>
    </header>
    {summary}
    <div id={bodyId} hidden={!open}>{children}</div>
  </section>
}
