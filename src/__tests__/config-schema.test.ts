import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, KiroConfigSchema } from '../plugin/config/schema.js'

describe('KiroConfig ACP transport', () => {
  test('uses ACP as the default transport and retains SDK as an explicit option', () => {
    expect(DEFAULT_CONFIG.transport).toBe('acp')
    expect(KiroConfigSchema.parse({}).transport).toBe('acp')
    expect(KiroConfigSchema.parse({ transport: 'sdk' }).transport).toBe('sdk')
  })

  test('accepts bounded ACP settings', () => {
    const config = KiroConfigSchema.parse({
      transport: 'acp',
      acp_agent: 'reviewer',
      acp_mcp_timeout_minutes: 15,
      acp_model_discovery_timeout_ms: 5000,
      acp_stall_after_ms: 0,
      acp_stall_live: 'off'
    })

    expect(config).toMatchObject({
      transport: 'acp',
      acp_agent: 'reviewer',
      acp_mcp_timeout_minutes: 15,
      acp_model_discovery_timeout_ms: 5000,
      acp_stall_after_ms: 0,
      acp_stall_live: 'off'
    })
  })

  test('rejects unsupported transport and unsafe ACP values', () => {
    expect(KiroConfigSchema.safeParse({ transport: 'both' }).success).toBe(false)
    expect(KiroConfigSchema.safeParse({ acp_mcp_timeout_minutes: 0 }).success).toBe(false)
    expect(KiroConfigSchema.safeParse({ acp_model_discovery_timeout_ms: 999 }).success).toBe(false)
    expect(KiroConfigSchema.safeParse({ acp_agent: '' }).success).toBe(false)
  })
})
