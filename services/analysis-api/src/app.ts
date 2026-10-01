import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { createApplicationServices, type ApplicationDependencies } from './service/application.js'
import { registerPortfolioMcp } from './api/portfolio-mcp.js'
import { registerFinancialDataMcp } from './api/financial-data-mcp.js'
import { registerSystemRoutes } from './api/system.js'
import { registerWorkbenchRoutes } from './api/workbench.js'
import { registerPortfolioRoutes } from './api/portfolio.js'
import { registerTrackingRoutes } from './api/tracking.js'
import { registerSettingsRoutes } from './api/settings.js'
import { registerAnalysisRoutes } from './api/analysis.js'
import { registerConversationRoutes } from './api/conversation.js'
import { registerResearchRoutes } from './api/research.js'

type AppDependencies = ApplicationDependencies & {
  staticDir?: string
  portfolioMcpToken?: string
  financialDataMcpToken?: string
  migrationVerificationToken?: string
}

export function buildApp(dependencies: AppDependencies) {
  const app = Fastify({ logger: false })
  const services = createApplicationServices(dependencies)
  registerPortfolioMcp(app, services.portfolio, dependencies.portfolioMcpToken)
  registerFinancialDataMcp(app, services.financialData, dependencies.financialDataMcpToken)
  app.addHook('onClose', () => services.close())
  app.addHook('onReady', () => services.initialize())
  if (dependencies.staticDir) {
    void app.register(fastifyStatic, { root: dependencies.staticDir })
    for (const route of ['/workbench', '/workbench/:id', '/research', '/research/:id', '/conversations/:id', '/conversation', '/portfolio', '/tracking', '/analysis', '/settings', '/trace']) {
      app.get(route, async (_request, reply) => reply.sendFile('index.html'))
    }
  }
  registerSystemRoutes(app, services, dependencies)
  registerWorkbenchRoutes(app, services)
  registerPortfolioRoutes(app, services)
  registerTrackingRoutes(app, services)
  registerSettingsRoutes(app, services)
  registerAnalysisRoutes(app, services)
  registerConversationRoutes(app, services)
  registerResearchRoutes(app, services)
  return app
}
