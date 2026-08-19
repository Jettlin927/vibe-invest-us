import { StrictMode, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app.js'
import { WorkbenchPrototype } from './prototype/workbench-prototype.js'
import './prototype/workbench-prototype.css'
import './styles.css'
import './trace.css'

const prototypeRoutes: Record<string, ComponentType> = {
  '/prototype/workbench': WorkbenchPrototype,
}
const Prototype = import.meta.env.DEV ? prototypeRoutes[window.location.pathname] : undefined

createRoot(document.getElementById('root')!).render(
  <StrictMode>{Prototype ? <Prototype /> : <App />}</StrictMode>,
)
