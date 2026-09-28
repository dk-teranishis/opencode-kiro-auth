import { describe, expect, test } from 'bun:test'
import { discoverAcpModelIDs } from '../plugin/acp-discovery.js'

describe('ACP model discovery', () => {
  test('keeps only non-empty runtime model IDs', async () => {
    const result = await discoverAcpModelIDs('/workspace', 1000, async () => [
      { modelId: 'claude-sonnet-5', name: 'Claude Sonnet 5', runtimeEfforts: [] },
      { modelId: '', name: 'invalid', runtimeEfforts: [] }
    ])

    expect(result.source).toBe('runtime')
    expect(Array.from(result.modelIDs)).toEqual(['claude-sonnet-5'])
  })

  test('fails closed when discovery fails', async () => {
    const result = await discoverAcpModelIDs('/workspace', 1000, async () => {
      throw new Error('unavailable')
    })

    expect(result).toEqual({ modelIDs: new Set(), source: 'empty' })
  })

  test('fails closed when discovery exceeds its deadline', async () => {
    const result = await discoverAcpModelIDs('/workspace', 1, () => new Promise(() => {}))

    expect(result).toEqual({ modelIDs: new Set(), source: 'empty' })
  })
})
