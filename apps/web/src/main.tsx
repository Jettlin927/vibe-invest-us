import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app.js'
import { WorkbenchPrototype } from './prototype/workbench-prototype.js'
import './prototype/workbench-prototype.css'
import './styles.css'

const prototypeRoute = import.meta.env.DEV && window.location.pathname === '/prototype/workbench'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{prototypeRoute ? <WorkbenchPrototype /> : <App />}</StrictMode>,
)
