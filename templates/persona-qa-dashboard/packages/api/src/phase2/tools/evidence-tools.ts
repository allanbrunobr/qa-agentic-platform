/**
 * Evidence tools — capture screenshots, DOM snippets, and domain artifacts
 * for agent session records.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolHandler, ToolMetadata, ToolContext, ToolResult } from '../types/tool-types.js'
import type { ToolRegistry } from '../services/tool-registry.js'
import { resolvePhase2ArtifactPath, type SessionService } from '../services/session-service.js'
import { hasRenderablePageContent, type EvidencePage } from './browser-page-evidence.js'

// --- captureScreenshot ---

export interface CaptureScreenshotInput {
  description: string
  fullPage?: boolean
}

/**
 * B-06: once the step that called a tool has ended (timeout or not), the tool must not store evidence
 * into it. Checked before touching the page and again right before writing.
 */
function stepAborted(context: ToolContext): ToolResult | null {
  if (!context.signal?.aborted) return null
  return {
    ok: false,
    error: { code: 'step_aborted', message: 'The step this tool belonged to has already ended; no evidence was stored.', retryable: false },
  }
}

export function makeCaptureScreenshotHandler(sessionService: SessionService): ToolHandler {
  return async (input: unknown, context: ToolContext): Promise<ToolResult> => {
    const { description, fullPage } = input as CaptureScreenshotInput

    if (!description) {
      return { ok: false, error: { code: 'invalid_input', message: 'description is required', retryable: false } }
    }
    if (!context.page) {
      return { ok: false, error: { code: 'missing_context', message: 'Playwright page is required for captureScreenshot', retryable: false } }
    }
    if (!context.sessionId) {
      return { ok: false, error: { code: 'missing_context', message: 'sessionId is required for captureScreenshot', retryable: false } }
    }

    const abortedBefore = stepAborted(context)
    if (abortedBefore) return abortedBefore

    try {
      const page = context.page as EvidencePage
      if (!(await hasRenderablePageContent(page))) {
        return {
          ok: false,
          error: {
            code: 'blank_page',
            message: 'Cannot capture screenshot because the current Playwright page has no renderable content',
            retryable: true,
          },
        }
      }

      const buffer = await page.screenshot({ fullPage: fullPage ?? false })
      const abortedAfterCapture = stepAborted(context)
      if (abortedAfterCapture) return abortedAfterCapture
      const filePath = `screenshots/${context.sessionId}/${Date.now()}.png`
      const absolutePath = resolvePhase2ArtifactPath(filePath)
      await mkdir(path.dirname(absolutePath), { recursive: true })
      await writeFile(absolutePath, buffer)

      const artifact = sessionService.storeArtifact(context.sessionId, {
        type: 'screenshot',
        agentRole: context.agentRole ?? 'unknown',
        description,
        filePath,
        metadata: { fullPage: fullPage ?? false, sizeBytes: buffer.length },
      })

      return { ok: true, output: { artifactId: artifact.id, filePath, sizeBytes: buffer.length } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: { code: 'screenshot_error', message, retryable: true } }
    }
  }
}

export const captureScreenshotMetadata: ToolMetadata = {
  name: 'captureScreenshot',
  description: 'Capture a screenshot of the current page for evidence',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'What this screenshot captures' },
      fullPage: { type: 'boolean', description: 'Capture full page (default: false)' },
    },
    required: ['description'],
  },
  requiresBrowser: true,
  tags: ['evidence', 'screenshot'],
}

// --- collectDomSnippet ---

export interface CollectDomSnippetInput {
  selector: string
  description: string
}

export function makeCollectDomSnippetHandler(sessionService: SessionService): ToolHandler {
  return async (input: unknown, context: ToolContext): Promise<ToolResult> => {
    const { selector, description } = input as CollectDomSnippetInput

    if (!selector || !description) {
      return { ok: false, error: { code: 'invalid_input', message: 'selector and description are required', retryable: false } }
    }
    if (!context.page) {
      return { ok: false, error: { code: 'missing_context', message: 'Playwright page is required for collectDomSnippet', retryable: false } }
    }
    if (!context.sessionId) {
      return { ok: false, error: { code: 'missing_context', message: 'sessionId is required for collectDomSnippet', retryable: false } }
    }

    const abortedBefore = stepAborted(context)
    if (abortedBefore) return abortedBefore

    try {
      const page = context.page as EvidencePage & { locator: (sel: string) => { innerHTML: () => Promise<string> } }
      const html = await page.locator(selector).innerHTML()
      // Measured with the same check captureScreenshot uses to refuse a page. A snippet of a blank
      // page is the only evidence a white screen can have, so a screenshot evidence policy accepts it.
      const pageBlank = !(await hasRenderablePageContent(page))
      const abortedAfterRead = stepAborted(context)
      if (abortedAfterRead) return abortedAfterRead

      const artifact = sessionService.storeArtifact(context.sessionId, {
        type: 'dom_snippet',
        agentRole: context.agentRole ?? 'unknown',
        description,
        content: html,
        metadata: { selector, pageBlank },
      })

      return { ok: true, output: { artifactId: artifact.id, selector, htmlLength: html.length, pageBlank } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: { code: 'dom_snippet_error', message, retryable: true } }
    }
  }
}

export const collectDomSnippetMetadata: ToolMetadata = {
  name: 'collectDomSnippet',
  description: 'Capture a DOM fragment as evidence of page state. The result says pageBlank: true when the page has no renderable '
    + 'content (captureScreenshot refuses such a page); a snippet with pageBlank: true can stand in for a screenshot as finding evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector for the DOM element' },
      description: { type: 'string', description: 'What this snippet captures' },
    },
    required: ['selector', 'description'],
  },
  requiresBrowser: true,
  tags: ['evidence', 'dom'],
}

// --- recordArtifact ---

export interface RecordArtifactInput {
  type: string
  payload: Record<string, unknown>
  description: string
}

export function makeRecordArtifactHandler(sessionService: SessionService): ToolHandler {
  return async (input: unknown, context: ToolContext): Promise<ToolResult> => {
    const { type, payload, description } = input as RecordArtifactInput

    if (!type || !payload || !description) {
      return { ok: false, error: { code: 'invalid_input', message: 'type, payload, and description are required', retryable: false } }
    }
    if (!context.sessionId) {
      return { ok: false, error: { code: 'missing_context', message: 'sessionId is required for recordArtifact', retryable: false } }
    }

    const aborted = stepAborted(context)
    if (aborted) return aborted

    try {
      const artifact = sessionService.storeArtifact(context.sessionId, {
        type: 'domain_artifact',
        agentRole: context.agentRole ?? 'unknown',
        description,
        content: JSON.stringify(payload),
        metadata: { artifactType: type },
      })

      return { ok: true, output: { artifactId: artifact.id, type } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: { code: 'artifact_error', message, retryable: false } }
    }
  }
}

export const recordArtifactMetadata: ToolMetadata = {
  name: 'recordArtifact',
  description: 'Record a domain artifact (e.g., customerId, orderId) as session evidence',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Artifact type (e.g., customerId, orderId)' },
      payload: { type: 'object', description: 'Artifact data' },
      description: { type: 'string', description: 'What this artifact represents' },
    },
    required: ['type', 'payload', 'description'],
  },
  requiresBrowser: false,
  tags: ['evidence', 'artifact'],
}

// --- Registration helper ---

export function registerEvidenceTools(registry: ToolRegistry, sessionService: SessionService): void {
  registry.register('captureScreenshot', makeCaptureScreenshotHandler(sessionService), captureScreenshotMetadata)
  registry.register('collectDomSnippet', makeCollectDomSnippetHandler(sessionService), collectDomSnippetMetadata)
  registry.register('recordArtifact', makeRecordArtifactHandler(sessionService), recordArtifactMetadata)
}
