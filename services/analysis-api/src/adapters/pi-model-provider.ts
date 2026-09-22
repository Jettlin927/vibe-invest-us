import { createModels, createProvider, fauxProvider, type Api, type FauxResponseStep, type Model } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { ModelOptions } from '../service/agent-runtime/model.js'
import type { PiAgentAdapterStream, PiAgentAdapterStreamFn } from './pi-agent-adapter.js'

export function createProviderRuntime(options: ModelOptions) {
  if (options.contextWindow !== undefined
    && (!Number.isInteger(options.contextWindow) || options.contextWindow <= 0)) {
    throw new Error('model_context_window_invalid')
  }
  const models = (options.modelsFactory ?? createModels)()
  let model: Model<Api>
  if (options.fauxResponses) {
    const faux = fauxProvider({ tokensPerSecond: options.fauxTokensPerSecond ?? 1000 })
    models.setProvider(faux.provider)
    faux.setResponses(options.fauxResponses as FauxResponseStep[])
    model = faux.getModel()
  } else if (options.provider && options.apiProtocol && options.modelName && options.baseUrl && options.apiKey) {
    const api = options.apiProtocol === 'responses' ? 'openai-responses' : 'openai-completions'
    const catalogModel = models.getModel(options.provider, options.modelName)
    const contextWindow = options.contextWindow ?? catalogModel?.contextWindow
    if (contextWindow === undefined) {
      throw new Error('model_context_window_required')
    }
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      throw new Error('model_context_window_invalid')
    }
    const configured: Model<Api> = {
      id: options.modelName, name: options.modelName, api, provider: options.provider,
      baseUrl: options.baseUrl, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow, maxTokens: Math.min(16_000, contextWindow),
    }
    models.setProvider(createProvider({
      id: options.provider, name: options.provider, baseUrl: options.baseUrl,
      auth: { apiKey: { name: 'provider API key', resolve: async () => ({ auth: { apiKey: options.apiKey } }) } },
      models: [configured],
      api: api === 'openai-responses' ? openAIResponsesApi() : openAICompletionsApi(),
    }))
    model = catalogModel ? { ...catalogModel, contextWindow } : configured
  } else throw new Error('model_not_configured')
  if (options.contextWindow !== undefined) model = { ...model, contextWindow: options.contextWindow }
  const streamFn: PiAgentAdapterStreamFn = (selected, context, streamOptions) => models.stream(
    selected as Model<Api>, context as never,
    { signal: streamOptions?.signal, apiKey: options.apiKey },
  ) as unknown as PiAgentAdapterStream
  return { model, streamFn }
}
