import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ToolRegistry } from '../services/tool-registry.js'
import { createSessionServiceStub } from '../services/session-service.js'
import {
  makeCaptureScreenshotHandler,
  makeCollectDomSnippetHandler,
  makeRecordArtifactHandler,
  registerEvidenceTools,
} from '../tools/evidence-tools.js'
import type { SessionService } from '../services/session-service.js'
import type { ToolContext } from '../types/tool-types.js'

function mockPage() {
  return {
    screenshot: async (_opts: unknown) => Buffer.from('fake-png-data'),
    locator: (selector: string) => ({
      innerHTML: async () => `<div data-sel="${selector}">content</div>`,
    }),
  }
}

function mockBlankPage() {
  return {
    screenshot: async (_opts: unknown) => Buffer.from('fake-png-data'),
    url: () => 'about:blank',
    evaluate: async () => false,
  }
}

describe('evidence-tools', () => {
  let sessionService: SessionService
  let ctx: ToolContext

  beforeEach(() => {
    sessionService = createSessionServiceStub()
    ctx = { page: mockPage(), sessionId: 'sess-1', agentRole: 'sales_associate' }
  })

  describe('captureScreenshot', () => {
    it('captures screenshot and stores artifact', async () => {
      const handler = makeCaptureScreenshotHandler(sessionService)
      const result = await handler({ description: 'customer form' }, ctx)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const out = result.output as Record<string, unknown>
        expect(out.artifactId).toBeDefined()
        expect(out.filePath).toContain('screenshots/')
        expect(out.sizeBytes).toBeGreaterThan(0)
      }
    })

    it('returns error without page', async () => {
      const handler = makeCaptureScreenshotHandler(sessionService)
      const result = await handler({ description: 'test' }, { sessionId: 'sess-1' })
      expect(result).toEqual({
        ok: false,
        error: { code: 'missing_context', message: expect.stringContaining('page'), retryable: false },
      })
    })

    it('returns error without sessionId', async () => {
      const handler = makeCaptureScreenshotHandler(sessionService)
      const result = await handler({ description: 'test' }, { page: mockPage() })
      expect(result).toEqual({
        ok: false,
        error: { code: 'missing_context', message: expect.stringContaining('sessionId'), retryable: false },
      })
    })

    it('returns error without description', async () => {
      const handler = makeCaptureScreenshotHandler(sessionService)
      const result = await handler({}, ctx)
      expect(result).toEqual({
        ok: false,
        error: { code: 'invalid_input', message: expect.stringContaining('description'), retryable: false },
      })
    })

    it('does not store blank screenshots as evidence', async () => {
      const handler = makeCaptureScreenshotHandler(sessionService)
      const result = await handler(
        { description: 'blank page' },
        { page: mockBlankPage(), sessionId: 'sess-1', agentRole: 'sales_associate' },
      )

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'blank_page',
          message: expect.stringContaining('no renderable content'),
          retryable: true,
        },
      })
    })
  })

  describe('collectDomSnippet', () => {
    it('captures DOM snippet and stores artifact', async () => {
      const handler = makeCollectDomSnippetHandler(sessionService)
      const result = await handler({ selector: '#form', description: 'customer form state' }, ctx)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const out = result.output as Record<string, unknown>
        expect(out.artifactId).toBeDefined()
        expect(out.selector).toBe('#form')
        expect(out.htmlLength).toBeGreaterThan(0)
      }
    })

    // Eighth pre-PR run: the snippet says whether its page was blank, measured with captureScreenshot's
    // own check, so a screenshot evidence policy can accept it for a white screen.
    it('reports whether the page was blank when the snippet was read', async () => {
      const handler = makeCollectDomSnippetHandler(sessionService)
      const storeArtifact = vi.spyOn(sessionService, 'storeArtifact')
      const blank = await handler(
        { selector: 'body', description: 'white screen' },
        { page: { ...mockBlankPage(), locator: () => ({ innerHTML: async () => '<div id="root"></div>' }) }, sessionId: 'sess-1', agentRole: 'sales_associate' },
      )
      const rendered = await handler({ selector: '#form', description: 'form' }, ctx)

      expect(blank.ok && (blank.output as Record<string, unknown>).pageBlank).toBe(true)
      expect(rendered.ok && (rendered.output as Record<string, unknown>).pageBlank).toBe(false)
      expect(storeArtifact.mock.calls.map(([, artifact]) => (artifact as { metadata?: Record<string, unknown> }).metadata?.['pageBlank'])).toEqual([true, false])
    })

    it('returns error without selector', async () => {
      const handler = makeCollectDomSnippetHandler(sessionService)
      const result = await handler({ description: 'test' }, ctx)
      expect(result).toEqual({
        ok: false,
        error: { code: 'invalid_input', message: expect.stringContaining('selector'), retryable: false },
      })
    })
  })

  describe('recordArtifact', () => {
    it('stores domain artifact', async () => {
      const handler = makeRecordArtifactHandler(sessionService)
      const result = await handler(
        { type: 'customerId', payload: { id: '42' }, description: 'created customer' },
        ctx,
      )

      expect(result.ok).toBe(true)
      if (result.ok) {
        const out = result.output as Record<string, unknown>
        expect(out.artifactId).toBeDefined()
        expect(out.type).toBe('customerId')
      }
    })

    it('does not require page (browser-free)', async () => {
      const handler = makeRecordArtifactHandler(sessionService)
      const result = await handler(
        { type: 'orderId', payload: { id: '99' }, description: 'scheduled order' },
        { sessionId: 'sess-1', agentRole: 'sales_associate' },
      )
      expect(result.ok).toBe(true)
    })

    it('returns error without sessionId', async () => {
      const handler = makeRecordArtifactHandler(sessionService)
      const result = await handler(
        { type: 'x', payload: {}, description: 'y' },
        {},
      )
      expect(result).toEqual({
        ok: false,
        error: { code: 'missing_context', message: expect.stringContaining('sessionId'), retryable: false },
      })
    })
  })

  describe('registerEvidenceTools', () => {
    it('registers all three tools', () => {
      const registry = new ToolRegistry()
      registerEvidenceTools(registry, sessionService)

      expect(registry.has('captureScreenshot')).toBe(true)
      expect(registry.has('collectDomSnippet')).toBe(true)
      expect(registry.has('recordArtifact')).toBe(true)
      expect(registry.listTools()).toHaveLength(3)
    })

    it('captureScreenshot requires browser, recordArtifact does not', () => {
      const registry = new ToolRegistry()
      registerEvidenceTools(registry, sessionService)

      expect(registry.getMetadata('captureScreenshot')?.requiresBrowser).toBe(true)
      expect(registry.getMetadata('collectDomSnippet')?.requiresBrowser).toBe(true)
      expect(registry.getMetadata('recordArtifact')?.requiresBrowser).toBe(false)
    })
  })
})
