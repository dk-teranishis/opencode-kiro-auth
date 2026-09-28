import type { ModelWithEfforts } from 'kiro-acp-ai-provider'

export interface AcpModelDiscoveryResult {
  readonly modelIDs: ReadonlySet<string>
  readonly source: 'runtime' | 'empty'
}

export type AcpModelLister = (options: { cwd: string }) => Promise<readonly ModelWithEfforts[]>

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export async function discoverAcpModelIDs(
  cwd: string,
  timeoutMs: number,
  listModels: AcpModelLister
): Promise<AcpModelDiscoveryResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const models = await Promise.race([
      listModels({ cwd }),
      new Promise<readonly ModelWithEfforts[]>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`ACP model discovery timed out after ${timeoutMs}ms`)), timeoutMs)
      })
    ])
    const modelIDs = new Set(models.map((model) => model.modelId).filter(isNonEmptyString))
    return modelIDs.size > 0 ? { modelIDs, source: 'runtime' } : { modelIDs, source: 'empty' }
  } catch {
    return { modelIDs: new Set(), source: 'empty' }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
