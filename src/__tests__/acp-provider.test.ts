import { describe, expect, test } from 'bun:test'
import type { KiroACPProvider } from 'kiro-acp-ai-provider'
import { ACP_PROVIDER_PACKAGE, KIRO_PROVIDER_ID } from '../plugin/acp-compatibility-gate.js'
import {
  createAcpProviderSettings,
  registerAcpProviderHooks,
  type AcpHookOptions
} from '../plugin/acp-provider.js'

function options(overrides: Partial<AcpHookOptions['config']> = {}): AcpHookOptions {
  return {
    directory: '/workspace/project',
    config: {
      acp_agent: 'opencode',
      acp_mcp_timeout_minutes: 30,
      acp_stall_after_ms: 10000,
      acp_stall_live: 'off',
      effort: undefined,
      auto_effort_mapping: true,
      ...overrides
    }
  }
}

function createHookHarness() {
  let sdkCallback: ((event: any) => Promise<void> | void) | undefined
  let languageCallback: ((event: any) => Promise<void> | void) | undefined
  const registrations: string[] = []
  const disposals: string[] = []

  return {
    context: {
      aisdk: {
        async hook(name: 'sdk' | 'language', callback: any, hookOptions: { providerID: string }) {
          expect(hookOptions.providerID).toBe(KIRO_PROVIDER_ID)
          registrations.push(name)
          if (name === 'sdk') sdkCallback = callback
          else languageCallback = callback
          return { dispose: async () => void disposals.push(name) }
        }
      }
    },
    callbacks: {
      sdk: async (event: any) => {
        if (sdkCallback === undefined) throw new Error('sdk hook was not registered')
        await sdkCallback(event)
      },
      language: async (event: any) => {
        if (languageCallback === undefined) throw new Error('language hook was not registered')
        await languageCallback(event)
      }
    },
    registrations,
    disposals
  }
}

describe('ACP provider path', () => {
  test('uses conservative provider settings and rejects ACP tool permissions', () => {
    const settings = createAcpProviderSettings(options({ acp_stall_live: 'reasoning' }))

    expect(settings).toMatchObject({
      cwd: '/workspace/project',
      agent: 'opencode',
      mcpTimeout: 30,
      trustAllTools: false,
      stall: { afterMs: 10000, live: 'reasoning' }
    })
    expect(settings.onPermission?.({} as any)).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  test('creates one ACP provider lazily and maps the selected model and effort', async () => {
    const harness = createHookHarness()
    const language = { id: 'acp-language-model' }
    const calls: Array<{ model: string; overrides: unknown }> = []
    let created = 0
    let shutdowns = 0
    const provider: KiroACPProvider = {
      languageModel(model, overrides) {
        calls.push({ model, overrides })
        return language as any
      },
      async shutdown() {
        shutdowns += 1
      }
    } as KiroACPProvider

    const dispose = await registerAcpProviderHooks(harness.context, options(), () => {
      created += 1
      return provider
    })
    expect(harness.registrations).toEqual(['sdk', 'language'])
    expect(created).toBe(0)

    const sdkEvent: { package: string; options: Record<string, unknown>; sdk?: unknown } = {
      package: ACP_PROVIDER_PACKAGE,
      options: {}
    }
    await harness.callbacks.sdk(sdkEvent)
    await harness.callbacks.sdk({ package: ACP_PROVIDER_PACKAGE, options: {} })
    expect(created).toBe(1)

    const languageEvent: {
      model: { modelID: string }
      options: Record<string, unknown>
      sdk: unknown
      language?: unknown
    } = {
      model: { modelID: 'claude-opus-4-8-thinking' },
      options: { thinkingConfig: { thinkingBudget: 98304 } },
      sdk: sdkEvent.sdk
    }
    await harness.callbacks.language(languageEvent)
    expect(calls).toEqual([
      { model: 'claude-opus-4.8', overrides: { contextWindow: 1000000, effort: 'xhigh' } }
    ])
    expect(languageEvent.language).toBe(language)

    await dispose()
    expect(harness.disposals).toEqual(['language', 'sdk'])
    expect(shutdowns).toBe(1)
  })

  test('does not create an ACP provider for another package', async () => {
    const harness = createHookHarness()
    let created = 0
    const dispose = await registerAcpProviderHooks(harness.context, options(), () => {
      created += 1
      return {} as KiroACPProvider
    })

    const existing = { provider: 'other' }
    await harness.callbacks.sdk({ package: '@opencode/ai/providers/openai-compatible', options: {}, sdk: existing })
    expect(created).toBe(0)
    await dispose()
  })
})
