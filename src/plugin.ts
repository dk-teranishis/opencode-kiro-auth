import { Model, Plugin, Provider } from '@opencode/plugin'
import { KIRO_CONSTANTS } from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { IdcAuthMethod } from './core/auth/idc-auth-method.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { loadConfig } from './plugin/config/index.js'
import { buildModelRegistry } from './plugin/model-registry.js'
import { formatWebSearchResults, kiroWebSearch } from './plugin/web-search.js'
import * as logger from './plugin/logger.js'

type ToastFunction = (message: string, variant: string) => void

const KIRO_PROVIDER_ID = 'kiro'

// Register Kiro's server-side web search as a custom tool, when enabled and the
// active account is Pro (has a profileArn). Returns an empty object otherwise so
// nothing is advertised to the model on free accounts.
//
// The description is adapted from Kiro's own web_search tool spec so the model
// gets the same guidance on when to search and how to attribute results.
const WEB_SEARCH_DESCRIPTION = `Search the web using Kiro's built-in search engine. Returns titles, URLs, snippets, domains, and publish dates for a query. Billed as Kiro credits.

## When to Use
- The user asks for current or up-to-date information (pricing, versions, release notes, recent events, library APIs).
- Verifying facts that may have changed recently, or details likely newer than the model's training data.
- Looking up specifics of a library, framework, or tool that can't be reliably inferred from the codebase or context.

## When NOT to Use
- Basic concepts, historical facts, or well-established programming syntax the model already knows.
- Anything answerable from the current repository, files, or conversation. Search the codebase first.

## Query Tips
- Keep queries focused; the query MUST be 200 characters or fewer (longer queries are rejected).
- Rephrase the user's request into effective keywords. Run multiple focused searches for complex questions rather than one broad query.
- The snippets often contain enough to answer directly; only fetch a full page (via a separate fetch tool) when you need more detail.

## Using Results & Attribution
- Prioritize the most recently published, authoritative sources (prefer official docs over blogs; use the domain to judge authority).
- ALWAYS cite sources with inline links in the format [description](url).
- Paraphrase and summarize; do not reproduce more than ~30 consecutive words verbatim from any single source. Preserve factual accuracy while condensing.`

function buildModels(providerID: ReturnType<typeof Provider.ID.make>) {
  return Object.entries(buildModelRegistry()).map(([modelID, legacy]) => {
    const model = legacy as any
    const variants = Object.entries(model.variants ?? {}).map(([id, settings]) => ({
      id: Model.VariantID.make(id),
      settings: settings as Record<string, unknown>
    }))
    return {
      ...Model.Info.default(providerID, Model.ID.make(modelID)),
      name: model.name,
      capabilities: { tools: true, input: model.modalities?.input ?? ['text'], output: ['text'] },
      variants,
      compatibility: model.reasoning
        ? { reasoningField: model.interleaved?.field ?? 'reasoning_content' }
        : undefined
    }
  })
}

export const KiroOAuthPlugin = Plugin.define({
  id: KIRO_PROVIDER_ID,
  async setup(ctx) {
    const config = loadConfig(ctx.location.directory)
    const showToast: ToastFunction = (message, variant) => logger.log(`Kiro ${variant}: ${message}`)
    const repository = new AccountRepository(new AccountCache(60000))
    const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
    const authHandler = new AuthHandler(config, repository)
    authHandler.setAccountManager(accountManager)
    await authHandler.initialize(showToast as any)

    const idcMethod = new IdcAuthMethod(config, repository, accountManager)
    const reauthenticate = async () => {
      const authorization = await idcMethod.authorize()
      await authorization.callback
      return true
    }
    const requestHandler = new RequestHandler(accountManager, config, repository, reauthenticate)
    const baseURL = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
      '{{region}}',
      config.default_region || 'us-east-1'
    )
    const providerID = Provider.ID.make(KIRO_PROVIDER_ID)

    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: 'Kiro',
          activation: 'enabled',
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL }
        },
        models: buildModels(providerID)
      })
    })

    await ctx.integration.transform((editor) => {
      for (const method of authHandler.getIntegrationMethods()) editor.method.update(method as any)
    })

    await ctx.session.hook(
      'http.response',
      async (event) => {
        logger.log('Kiro native HTTP response intercepted', { kind: event.kind })
        event.response = await requestHandler.handle(event.request.clone(), undefined, showToast)
      },
      { providerID: KIRO_PROVIDER_ID }
    )

    if (config.web_search_enabled && accountManager.getCurrentOrNext()?.profileArn) {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: 'kiro_web_search',
          description: WEB_SEARCH_DESCRIPTION,
          input: {
            type: 'object',
            properties: { query: { type: 'string', maxLength: 200, description: 'The search query. Must be 200 characters or fewer.' } },
            required: ['query'],
            additionalProperties: false
          },
          async execute(input) {
            try {
              const results = await kiroWebSearch(accountManager, (input as { query: string }).query)
              return { content: formatWebSearchResults(results) }
            } catch (e) {
              return { content: `Web search failed: ${e instanceof Error ? e.message : String(e)}` }
            }
          }
        })
      })
    }
  }
})

export const createKiroPlugin = () => KiroOAuthPlugin
