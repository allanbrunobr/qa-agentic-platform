import { describe, it, expect, beforeEach } from 'vitest'
import { ToolRiskLevelSchema, ToolMetadataSchema } from '../types/tool-types.js'
import type { ToolHandler, ToolMetadata } from '../types/tool-types.js'
import { ToolRegistry } from '../services/tool-registry.js'

const echoHandler: ToolHandler = async (input) => ({ ok: true, output: input })

function makeMetadata(overrides: Partial<ToolMetadata> & { name: string }): ToolMetadata {
  return { description: `Tool ${overrides.name}`, requiresBrowser: false, tags: [], ...overrides }
}

describe('Story 1.2: Classify Tools by Risk Level', () => {
  describe('ToolRiskLevel enum', () => {
    it('accepts read, write, and destructive', () => {
      expect(ToolRiskLevelSchema.parse('read')).toBe('read')
      expect(ToolRiskLevelSchema.parse('write')).toBe('write')
      expect(ToolRiskLevelSchema.parse('destructive')).toBe('destructive')
    })

    it('rejects invalid risk levels', () => {
      expect(() => ToolRiskLevelSchema.parse('extreme')).toThrow()
      expect(() => ToolRiskLevelSchema.parse('')).toThrow()
    })
  })

  describe('ToolMetadata schema with riskLevel', () => {
    it('allows riskLevel to be omitted (optional for backward compat)', () => {
      const parsed = ToolMetadataSchema.parse({ name: 'foo', description: 'bar' })
      expect(parsed.riskLevel).toBeUndefined()
    })

    it('accepts explicit riskLevel', () => {
      const parsed = ToolMetadataSchema.parse({
        name: 'deploy',
        description: 'Deploy to production',
        riskLevel: 'destructive',
      })
      expect(parsed.riskLevel).toBe('destructive')
    })

    it('rejects invalid riskLevel', () => {
      expect(() => ToolMetadataSchema.parse({
        name: 'foo',
        description: 'bar',
        riskLevel: 'extreme',
      })).toThrow()
    })
  })

  describe('ToolRegistry risk classification', () => {
    let registry: ToolRegistry

    beforeEach(() => {
      registry = new ToolRegistry()
    })

    it('getRiskLevel returns the registered risk level', () => {
      registry.register('deploy', echoHandler, makeMetadata({ name: 'deploy', riskLevel: 'destructive' }))
      expect(registry.getRiskLevel('deploy')).toBe('destructive')
    })

    it('getRiskLevel returns "read" for tools without explicit riskLevel', () => {
      registry.register('fetch', echoHandler, makeMetadata({ name: 'fetch' }))
      expect(registry.getRiskLevel('fetch')).toBe('read')
    })

    it('getRiskLevel returns undefined for unknown tools', () => {
      expect(registry.getRiskLevel('nonexistent')).toBeUndefined()
    })

    it('getByRiskLevel filters tools correctly', () => {
      registry.register('readA', echoHandler, makeMetadata({ name: 'readA', riskLevel: 'read' }))
      registry.register('readB', echoHandler, makeMetadata({ name: 'readB', riskLevel: 'read' }))
      registry.register('writeC', echoHandler, makeMetadata({ name: 'writeC', riskLevel: 'write' }))
      registry.register('destroyD', echoHandler, makeMetadata({ name: 'destroyD', riskLevel: 'destructive' }))

      expect(registry.getByRiskLevel('read')).toHaveLength(2)
      expect(registry.getByRiskLevel('write')).toHaveLength(1)
      expect(registry.getByRiskLevel('destructive')).toHaveLength(1)
    })

    it('getByRiskLevel returns empty array for no matches', () => {
      registry.register('readOnly', echoHandler, makeMetadata({ name: 'readOnly', riskLevel: 'read' }))
      expect(registry.getByRiskLevel('destructive')).toHaveLength(0)
    })
  })

  describe('ToolRegistry immutable metadata', () => {
    let registry: ToolRegistry

    beforeEach(() => {
      registry = new ToolRegistry()
    })

    it('mutating original object does not affect stored metadata', () => {
      const original: ToolMetadata = { name: 'mutTest', description: 'test', riskLevel: 'read', requiresBrowser: false, tags: [] }
      registry.register('mutTest', echoHandler, original)
      original.riskLevel = 'destructive'
      expect(registry.getRiskLevel('mutTest')).toBe('read')
    })

    it('returned metadata is frozen — mutation throws in strict mode', () => {
      registry.register('frozenTest', echoHandler, makeMetadata({ name: 'frozenTest', riskLevel: 'read' }))
      const retrieved = registry.getMetadata('frozenTest')!
      expect(() => {
        (retrieved as { riskLevel: string }).riskLevel = 'destructive'
      }).toThrow()
      expect(registry.getRiskLevel('frozenTest')).toBe('read')
    })

    it('listTools returns frozen metadata objects', () => {
      registry.register('listTest', echoHandler, makeMetadata({ name: 'listTest', riskLevel: 'write' }))
      const list = registry.listTools()
      expect(() => {
        (list[0] as { riskLevel: string }).riskLevel = 'destructive'
      }).toThrow()
    })

    it('rejects duplicate tool names', () => {
      registry.register('dup', echoHandler, makeMetadata({ name: 'dup' }))
      expect(() => registry.register('dup', echoHandler, makeMetadata({ name: 'dup' }))).toThrow(/already registered/)
    })
  })
})
