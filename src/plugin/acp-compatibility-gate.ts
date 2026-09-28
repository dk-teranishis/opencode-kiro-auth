export const ACP_PROVIDER_PACKAGE = 'aisdk:kiro-acp-ai-provider'
export const ACP_PROVIDER_VERSION = '3.2.0'
export const KIRO_PROVIDER_ID = 'kiro'

export interface CompatibilitySdkEvent {
  readonly package: string
  readonly options: Record<string, unknown>
  sdk?: unknown
}

export interface CompatibilityLanguageEvent {
  readonly model: { readonly modelID: string }
  readonly options: Record<string, unknown>
  readonly sdk: unknown
  language?: unknown
}

export interface CompatibilityRegistration {
  dispose(): Promise<void>
}

export interface CompatibilityAisdkHooks {
  hook(
    name: 'sdk',
    callback: (event: CompatibilitySdkEvent) => Promise<void> | void,
    options: { providerID: string }
  ): Promise<CompatibilityRegistration>
  hook(
    name: 'language',
    callback: (event: CompatibilityLanguageEvent) => Promise<void> | void,
    options: { providerID: string }
  ): Promise<CompatibilityRegistration>
}

export interface CompatibilityAcpProvider {
  languageModel(modelID: string, overrides?: { effort?: string }): unknown
}

export interface CompatibilityGateContext {
  readonly aisdk: CompatibilityAisdkHooks
}

export type CompatibilityAcpProviderFactory = () => CompatibilityAcpProvider

/**
 * Registers the same two V2 AISDK hook shapes that the ACP implementation will
 * use in phase 2. It deliberately accepts a mock provider factory: this gate
 * must not launch kiro-cli, read credentials, or send a model request.
 */
export async function registerAcpCompatibilityGate(
  context: CompatibilityGateContext,
  createProvider: CompatibilityAcpProviderFactory
): Promise<() => Promise<void>> {
  const sdkRegistration = await context.aisdk.hook(
    'sdk',
    (event) => {
      if (event.package === ACP_PROVIDER_PACKAGE) event.sdk = createProvider()
    },
    { providerID: KIRO_PROVIDER_ID }
  )

  let languageRegistration: CompatibilityRegistration
  try {
    languageRegistration = await context.aisdk.hook(
      'language',
      (event) => {
        const provider = event.sdk as CompatibilityAcpProvider
        const effort = typeof event.options.effort === 'string' ? event.options.effort : undefined
        event.language = provider.languageModel(event.model.modelID, effort === undefined ? undefined : { effort })
      },
      { providerID: KIRO_PROVIDER_ID }
    )
  } catch (error) {
    await sdkRegistration.dispose()
    throw error
  }

  return async () => {
    await languageRegistration.dispose()
    await sdkRegistration.dispose()
  }
}
