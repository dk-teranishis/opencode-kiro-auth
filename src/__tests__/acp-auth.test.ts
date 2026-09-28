import { describe, expect, test } from 'bun:test'
import {
  describeAcpAuthStatus,
  registerAcpAuthIntegration
} from '../plugin/acp-auth.js'

describe('ACP authentication integration', () => {
  test('describes CLI auth states without exposing account data', () => {
    expect(describeAcpAuthStatus({ installed: false, authenticated: false })).toBe('not-installed')
    expect(describeAcpAuthStatus({ installed: true, authenticated: false })).toBe('signed-out')
    expect(describeAcpAuthStatus({ installed: true, authenticated: true })).toBe('ready')
  })

  test('returns a non-secret credential presence record when already authenticated', async () => {
    let registration: any
    const dispose = await registerAcpAuthIntegration(
      {
        integration: {
          async transform(callback) {
            const method = { update(input: any) { registration = input } }
            callback({ update() {}, method })
            return { dispose: async () => {} }
          }
        }
      },
      async () => ({ installed: true, authenticated: true })
    )

    const authorization = await registration.authorize()
    expect(authorization.mode).toBe('auto')
    await expect(authorization.callback).resolves.toEqual({
      type: 'oauth',
      methodID: 'kiro-cli-login',
      refresh: '',
      access: 'kiro-cli',
      expires: 0
    })
    await dispose()
  })

  test('rejects login without kiro-cli before launching a process', async () => {
    let registration: any
    let launches = 0
    await registerAcpAuthIntegration(
      {
        integration: {
          async transform(callback) {
            callback({ update() {}, method: { update(input: any) { registration = input } } })
            return { dispose: async () => {} }
          }
        }
      },
      async () => ({ installed: false, authenticated: false }),
      () => {
        launches += 1
        return { kill() {} }
      }
    )

    await expect(registration.authorize()).rejects.toThrow('kiro-cli is not installed')
    expect(launches).toBe(0)
  })
})
