import { execFile } from 'node:child_process'

export const ACP_INTEGRATION_ID = 'kiro'
const ACP_LOGIN_METHOD_ID = 'kiro-cli-login'
const ACP_DOCS_URL = 'https://kiro.dev/docs/cli/'
const POLL_INTERVAL_MS = 2000
const LOGIN_TIMEOUT_MS = 120000

export interface AcpAuthStatus {
  readonly installed: boolean
  readonly authenticated: boolean
}

export interface AcpAuthContext {
  readonly integration: {
    transform(callback: (editor: any) => void): Promise<{ dispose(): Promise<void> }>
  }
}

export type AcpAuthVerifier = () => Promise<AcpAuthStatus>
export type AcpLoginLauncher = () => { kill(): void }

function createCredential() {
  return {
    type: 'oauth' as const,
    methodID: ACP_LOGIN_METHOD_ID,
    refresh: '',
    access: 'kiro-cli',
    expires: 0
  }
}

function createLoginLauncher(): AcpLoginLauncher {
  return () => execFile('kiro-cli', ['login'], { shell: process.platform === 'win32' })
}

function waitForAuthentication(
  verify: AcpAuthVerifier,
  child: { kill(): void },
  intervalMs = POLL_INTERVAL_MS,
  timeoutMs = LOGIN_TIMEOUT_MS
): Promise<ReturnType<typeof createCredential>> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      child.kill()
      callback()
    }

    const poll = async (): Promise<void> => {
      const status = await verify()
      if (status.authenticated) {
        finish(() => resolve(createCredential()))
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        finish(() => reject(new Error('Kiro CLI login timed out; run `kiro-cli login` and retry.')))
        return
      }
      timer = setTimeout(() => void poll(), intervalMs)
    }

    void poll()
  })
}

export function describeAcpAuthStatus(status: AcpAuthStatus): 'ready' | 'signed-out' | 'not-installed' {
  if (!status.installed) return 'not-installed'
  return status.authenticated ? 'ready' : 'signed-out'
}

/**
 * Registers an OAuth presence record for OpenCode. Kiro CLI remains the sole
 * owner of credentials and refresh; this module never returns AWS tokens.
 */
export async function registerAcpAuthIntegration(
  context: AcpAuthContext,
  verify: AcpAuthVerifier,
  launch: AcpLoginLauncher = createLoginLauncher()
): Promise<() => Promise<void>> {
  const registration = await context.integration.transform((editor) => {
    editor.update(ACP_INTEGRATION_ID, (integration: { name: string }) => {
      integration.name = 'Kiro (ACP)'
    })
    editor.method.update({
      integrationID: ACP_INTEGRATION_ID,
      method: { id: ACP_LOGIN_METHOD_ID, type: 'oauth', label: 'Kiro CLI Login' },
      authorize: async () => {
        const status = await verify()
        if (!status.installed) {
          throw new Error('kiro-cli is not installed. Install it from https://kiro.dev/docs/cli/')
        }
        if (status.authenticated) {
          return {
            url: ACP_DOCS_URL,
            instructions: 'Kiro CLI is already authenticated.',
            mode: 'auto' as const,
            callback: Promise.resolve(createCredential())
          }
        }
        return {
          url: ACP_DOCS_URL,
          instructions: 'Complete Kiro CLI login in the browser window, then wait for verification.',
          mode: 'auto' as const,
          callback: waitForAuthentication(verify, launch())
        }
      }
    })
  })

  return () => registration.dispose()
}
