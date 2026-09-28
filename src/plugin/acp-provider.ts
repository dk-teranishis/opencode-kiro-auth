import {
  createKiroAcp,
  type KiroACPProvider,
  type KiroACPProviderSettings,
  type PermissionDecision
} from 'kiro-acp-ai-provider'
import { ACP_PROVIDER_PACKAGE, KIRO_PROVIDER_ID } from './acp-compatibility-gate.js'
import type { KiroConfig } from './config/schema.js'
import { budgetToEffort, getEffectiveEffort } from './effort.js'
import { resolveKiroModel } from './models.js'

const CLIENT_INFO = { name: 'opencode-kiro-auth', version: '2.0.0' } as const

type SdkHookEvent = {
  readonly package: string
  readonly options: Record<string, unknown>
  sdk?: unknown
}

type LanguageHookEvent = {
  readonly model: { readonly modelID: string }
  readonly options: Record<string, unknown>
  readonly sdk: unknown
  language?: unknown
}

type Registration = { dispose(): Promise<void> }

export interface AcpHookContext {
  readonly aisdk: {
    hook(
      name: 'sdk',
      callback: (event: SdkHookEvent) => Promise<void> | void,
      options: { providerID: string }
    ): Promise<Registration>
    hook(
      name: 'language',
      callback: (event: LanguageHookEvent) => Promise<void> | void,
      options: { providerID: string }
    ): Promise<Registration>
  }
}

export interface AcpHookOptions {
  readonly directory: string
  readonly config: Pick<
    KiroConfig,
    | 'acp_agent'
    | 'acp_mcp_timeout_minutes'
    | 'acp_stall_after_ms'
    | 'acp_stall_live'
    | 'effort'
    | 'auto_effort_mapping'
  >
}

export type AcpProviderFactory = (settings: KiroACPProviderSettings) => KiroACPProvider

function isAcpPackage(packageName: string): boolean {
  return packageName === ACP_PROVIDER_PACKAGE || packageName === 'kiro-acp-ai-provider'
}

function isAcpProvider(value: unknown): value is KiroACPProvider {
  return typeof value === 'object' && value !== null && typeof (value as KiroACPProvider).languageModel === 'function'
}

function denyAcpToolPermission(): PermissionDecision {
  return { outcome: { outcome: 'cancelled' } }
}

function thinkingBudget(options: Record<string, unknown>): number {
  const config = options.thinkingConfig
  if (typeof config !== 'object' || config === null) return 0
  const budget = (config as Record<string, unknown>).thinkingBudget
  return typeof budget === 'number' && Number.isFinite(budget) ? budget : 0
}

function isReasoningModel(modelID: string, kiroModel: string): boolean {
  return modelID.endsWith('-thinking') || kiroModel.startsWith('gpt-5.6-')
}

const MILLION_TOKEN_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-fable-5-1'
])

function contextWindowForModel(modelID: string, kiroModel: string): number {
  if (kiroModel.startsWith('gpt-5.6-')) return 272000
  return MILLION_TOKEN_MODELS.has(modelID) ? 1000000 : 200000
}

function resolveEffort(
  modelID: string,
  kiroModel: string,
  options: Record<string, unknown>,
  config: AcpHookOptions['config']
): string | undefined {
  if (typeof options.effort === 'string') return options.effort
  if (!isReasoningModel(modelID, kiroModel)) return undefined

  const budget = thinkingBudget(options)
  return getEffectiveEffort(
    kiroModel,
    true,
    budget,
    config.effort,
    config.auto_effort_mapping
  ) ?? budgetToEffort(budget, kiroModel)
}

export function createAcpProviderSettings(options: AcpHookOptions): KiroACPProviderSettings {
  return {
    cwd: options.directory,
    agent: options.config.acp_agent,
    clientInfo: CLIENT_INFO,
    mcpTimeout: options.config.acp_mcp_timeout_minutes,
    stall: {
      afterMs: options.config.acp_stall_after_ms,
      live: options.config.acp_stall_live
    },
    trustAllTools: false,
    onPermission: denyAcpToolPermission
  }
}

/**
 * Registers the ACP provider path for a single plugin location. The provider is
 * created lazily from the AISDK sdk hook, so plugin setup does not spawn
 * kiro-cli, read CLI credentials, or issue a model request.
 */
export async function registerAcpProviderHooks(
  context: AcpHookContext,
  options: AcpHookOptions,
  factory: AcpProviderFactory = createKiroAcp
): Promise<() => Promise<void>> {
  let provider: KiroACPProvider | undefined

  const sdkRegistration = await context.aisdk.hook(
    'sdk',
    (event) => {
      if (!isAcpPackage(event.package)) return
      provider ??= factory(createAcpProviderSettings(options))
      event.sdk = provider
    },
    { providerID: KIRO_PROVIDER_ID }
  )

  let languageRegistration: Registration
  try {
    languageRegistration = await context.aisdk.hook(
      'language',
      (event) => {
        if (!isAcpProvider(event.sdk)) return
        const acpProvider = event.sdk
        const modelID = String(event.model.modelID)
        const baseModelID = modelID.endsWith('-thinking') ? modelID.slice(0, -'-thinking'.length) : modelID
        const kiroModel = resolveKiroModel(modelID)
        const effort = resolveEffort(modelID, kiroModel, event.options, options.config)
        event.language = acpProvider.languageModel(kiroModel, {
          contextWindow: contextWindowForModel(baseModelID, kiroModel),
          ...(effort === undefined ? {} : { effort })
        })
      },
      { providerID: KIRO_PROVIDER_ID }
    )
  } catch (error) {
    await sdkRegistration.dispose()
    throw error
  }

  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    const errors: unknown[] = []
    for (const dispose of [languageRegistration.dispose, sdkRegistration.dispose]) {
      try {
        await dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    if (provider !== undefined) {
      try {
        await provider.shutdown()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'ACP provider cleanup failed')
  }
}
