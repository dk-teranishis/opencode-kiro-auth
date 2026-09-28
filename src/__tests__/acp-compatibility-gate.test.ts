import { describe, expect, test } from 'bun:test'
import {
  ACP_PROVIDER_PACKAGE,
  ACP_PROVIDER_VERSION,
  KIRO_PROVIDER_ID,
  registerAcpCompatibilityGate,
  type CompatibilityAcpProvider,
  type CompatibilityLanguageEvent,
  type CompatibilitySdkEvent
} from '../plugin/acp-compatibility-gate.js'

function createHookHarness() {
  let sdkCallback: ((event: CompatibilitySdkEvent) => Promise<void> | void) | undefined
  let languageCallback: ((event: CompatibilityLanguageEvent) => Promise<void> | void) | undefined
  const registrations: string[] = []
  const disposals: string[] = []

  return {
    context: {
      aisdk: {
        async hook(name: 'sdk' | 'language', callback: any, options: { providerID: string }) {
          expect(options.providerID).toBe(KIRO_PROVIDER_ID)
          registrations.push(name)
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
      sdk: async (event: CompatibilitySdkEvent) => {
        if (sdkCallback === undefined) throw new Error('sdk hook was not registered')
        await sdkCallback(event)
      },
      language: async (event: CompatibilityLanguageEvent) => {
        if (languageCallback === undefined) throw new Error('language hook was not registered')
        await languageCallback(event)
      }
    },
    registrations,
    disposals
  }
}

describe('ACP compatibility gate', () => {
  test('pins the provider package contract used by the gate', () => {
    expect(ACP_PROVIDER_PACKAGE).toBe('aisdk:kiro-acp-ai-provider')
    expect(ACP_PROVIDER_VERSION).toBe('3.2.0')
  })

  test('uses the mock ACP provider for the selected model without starting kiro-cli', async () => {
    const harness = createHookHarness()
    const language = { probe: 'normal' }
    const calls: Array<{ modelID: string; effort?: string }> = []
    const provider: CompatibilityAcpProvider = {
      languageModel(modelID, overrides) {
        calls.push({ modelID, effort: overrides?.effort })
        return language
      }
    }

    const dispose = await registerAcpCompatibilityGate(harness.context, () => provider)

    expect(harness.registrations).toEqual(['sdk', 'language'])
    const sdkEvent: CompatibilitySdkEvent = { package: ACP_PROVIDER_PACKAGE, options: {} }
    await harness.callbacks.sdk(sdkEvent)
    expect(sdkEvent.sdk).toBe(provider)

    const languageEvent: CompatibilityLanguageEvent = {
      model: { modelID: 'mock-acp-model' },
      options: { effort: 'high' },
      sdk: sdkEvent.sdk
    }
    await harness.callbacks.language(languageEvent)

    expect(calls).toEqual([{ modelID: 'mock-acp-model', effort: 'high' }])
    expect(languageEvent.language).toBe(language)

    await dispose()
    expect(harness.disposals).toEqual(['language', 'sdk'])
  })

  test('does not replace a non-ACP SDK and preserves observable mock outcomes', async () => {
    const harness = createHookHarness()
    const existingSdk = { source: 'other-provider' }
    const outcomes = ['normal', 'error', 'cancelled']
    let created = 0
    const dispose = await registerAcpCompatibilityGate(harness.context, () => ({
      languageModel(modelID) {
        return { modelID, outcome: outcomes[created - 1] }
      }
    }))

    const unrelated: CompatibilitySdkEvent = {
      package: '@opencode/ai/providers/openai-compatible',
      options: {},
      sdk: existingSdk
    }
    await harness.callbacks.sdk(unrelated)
    expect(unrelated.sdk).toBe(existingSdk)

    for (const expected of outcomes) {
      const sdkEvent: CompatibilitySdkEvent = { package: ACP_PROVIDER_PACKAGE, options: {} }
      created += 1
      await harness.callbacks.sdk(sdkEvent)
      const languageEvent: CompatibilityLanguageEvent = {
        model: { modelID: `mock-${expected}` },
        options: {},
        sdk: sdkEvent.sdk
      }
      await harness.callbacks.language(languageEvent)
      expect(languageEvent.language).toEqual({ modelID: `mock-${expected}`, outcome: expected })
    }

    await dispose()
  })
})
