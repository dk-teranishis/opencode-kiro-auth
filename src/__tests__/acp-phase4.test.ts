import { describe, expect, test } from 'bun:test'
import type { KiroACPProvider } from 'kiro-acp-ai-provider'
import { ACP_PROVIDER_PACKAGE, KIRO_PROVIDER_ID } from '../plugin/acp-compatibility-gate.js'
import { registerAcpProviderHooks, type AcpHookOptions } from '../plugin/acp-provider.js'

function options(): AcpHookOptions {
  return {
    directory: '/workspace/project',
    config: {
      acp_agent: 'opencode',
      acp_mcp_timeout_minutes: 30,
      acp_stall_after_ms: 10000,
      acp_stall_live: 'off',
      effort: undefined,
      auto_effort_mapping: true
    }
  }
}

function createHookHarness(options: { failLanguageRegistration?: boolean } = {}) {
  let sdkCallback: ((event: any) => Promise<void> | void) | undefined
  let languageCallback: ((event: any) => Promise<void> | void) | undefined
  const disposals: string[] = []

  return {
    context: {
      aisdk: {
        async hook(name: 'sdk' | 'language', callback: any, hookOptions: { providerID: string }) {
          expect(hookOptions.providerID).toBe(KIRO_PROVIDER_ID)
          if (name === 'language' && options.failLanguageRegistration) throw new Error('language registration failed')
          if (name === 'sdk') sdkCallback = callback
          else languageCallback = callback
          return {
            dispose: async () => {
              disposals.push(name)
            }
          }
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
    disposals
  }
}

function eventFor(modelID: string, sdk: unknown, options: Record<string, unknown> = {}) {
  return { model: { modelID }, options, sdk, language: undefined as unknown }
}

describe('ACP phase 4 simulated lifecycle', () => {
  test('surfaces ACP startup failure without a retry or a model invocation', async () => {
    const harness = createHookHarness()
    let attempts = 0
    const dispose = await registerAcpProviderHooks(harness.context, options(), () => {
      attempts += 1
      throw new Error('simulated ACP startup failure')
    })

    await expect(harness.callbacks.sdk({ package: ACP_PROVIDER_PACKAGE, options: {} })).rejects.toThrow(
      'simulated ACP startup failure'
    )
    expect(attempts).toBe(1)
    await dispose()
  })

  test('passes normal, interrupted, idle, and cancelled model outcomes through without replaying a request', async () => {
    const harness = createHookHarness()
    const outcomes = ['normal', 'before-output-interrupted', 'after-output-interrupted', 'long-idle', 'cancelled']
    const models = new Map(outcomes.map((outcome) => [outcome, { outcome }]))
    const calls: string[] = []
    const provider: KiroACPProvider = {
      languageModel(modelID: string) {
        calls.push(modelID)
        return models.get(outcomes[calls.length - 1]!) as any
      },
      async shutdown() {}
    } as unknown as KiroACPProvider
    const dispose = await registerAcpProviderHooks(harness.context, options(), () => provider)
    const sdkEvent: { package: string; options: Record<string, unknown>; sdk?: unknown } = {
      package: ACP_PROVIDER_PACKAGE,
      options: {}
    }
    await harness.callbacks.sdk(sdkEvent)

    for (const outcome of outcomes) {
      const event = eventFor('claude-sonnet-5', sdkEvent.sdk)
      await harness.callbacks.language(event)
      expect(event.language).toBe(models.get(outcome))
    }
    expect(calls).toEqual(outcomes.map(() => 'claude-sonnet-5'))
    await dispose()
  })

  test('uses the same ACP hook path for primary, title, compaction, and generate flows', async () => {
    const harness = createHookHarness()
    const calls: string[] = []
    const provider: KiroACPProvider = {
      languageModel(modelID: string) {
        calls.push(modelID)
        return { modelID } as any
      },
      async shutdown() {}
    } as unknown as KiroACPProvider
    const dispose = await registerAcpProviderHooks(harness.context, options(), () => provider)
    const sdkEvent: { package: string; options: Record<string, unknown>; sdk?: unknown } = {
      package: ACP_PROVIDER_PACKAGE,
      options: {}
    }
    await harness.callbacks.sdk(sdkEvent)

    for (const flow of ['primary', 'title', 'compaction', 'generate']) {
      const event = eventFor('claude-sonnet-5', sdkEvent.sdk, { flow })
      await harness.callbacks.language(event)
      expect(event.language).toEqual({ modelID: 'claude-sonnet-5' })
    }
    expect(calls).toEqual(['claude-sonnet-5', 'claude-sonnet-5', 'claude-sonnet-5', 'claude-sonnet-5'])
    await dispose()
  })

  test('ignores a language hook without an ACP SDK instead of throwing or replacing it', async () => {
    const harness = createHookHarness()
    const dispose = await registerAcpProviderHooks(harness.context, options(), () => {
      throw new Error('factory must not be called')
    })

    const event = eventFor('claude-sonnet-5', { source: 'another-provider' })
    await harness.callbacks.language(event)
    expect(event.language).toBeUndefined()
    await dispose()
  })

  test('releases registrations and provider once across repeated reload cleanup', async () => {
    const harness = createHookHarness()
    let shutdowns = 0
    const provider: KiroACPProvider = {
      languageModel() {
        return {} as any
      },
      async shutdown() {
        shutdowns += 1
      }
    } as unknown as KiroACPProvider
    const dispose = await registerAcpProviderHooks(harness.context, options(), () => provider)
    await harness.callbacks.sdk({ package: ACP_PROVIDER_PACKAGE, options: {} })

    await dispose()
    await dispose()

    expect(harness.disposals).toEqual(['language', 'sdk'])
    expect(shutdowns).toBe(1)
  })

  test('cleans up the SDK registration when language-hook registration fails', async () => {
    const harness = createHookHarness({ failLanguageRegistration: true })

    await expect(registerAcpProviderHooks(harness.context, options())).rejects.toThrow('language registration failed')
    expect(harness.disposals).toEqual(['sdk'])
  })
})
