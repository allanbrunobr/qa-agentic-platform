import { describe, it, expect, beforeEach } from 'vitest'
import { SyntheticToolResultSchema } from '../types/agent-types.js'
import { SessionService } from '../services/session-service.js'
import { AgentRuntime } from '../services/agent-runtime.js'
import { ToolRegistry } from '../services/tool-registry.js'
import type { ToolHandler, ToolMetadata } from '../types/tool-types.js'
import type { AgentProfile, ModelProvider, ModelResponse } from '../types/agent-types.js'

const echoHandler: ToolHandler = async (input) => ({ ok: true, output: input })

function makeMetadata(name: string): ToolMetadata {
  return { name, description: `Tool ${name}`, requiresBrowser: false, tags: [] }
}

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    role: 'test-agent',
    timeoutMs: 30_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    toolPolicy: { browserAccess: false },
    evidencePolicy: { requireScreenshotForFinding: false, requireDomSnippetForFinding: false },
    canBlockRun: false,
    ...overrides,
  }
}

describe('Story 1.1: Close Tool Ledger on Timeout and Interruption', () => {
  describe('SyntheticToolResult schema validation', () => {
    it('validates a timeout synthetic result', () => {
      const result = {
        toolCallId: 'tc-001',
        toolName: 'fetchData',
        reason: 'timeout',
        closedAt: new Date().toISOString(),
        originalStartedAt: new Date().toISOString(),
      }
      expect(() => SyntheticToolResultSchema.parse(result)).not.toThrow()
    })

    it('validates an interruption synthetic result', () => {
      const result = {
        toolCallId: 'tc-002',
        toolName: 'writeFile',
        reason: 'interruption',
        closedAt: new Date().toISOString(),
        originalStartedAt: new Date().toISOString(),
      }
      expect(() => SyntheticToolResultSchema.parse(result)).not.toThrow()
    })

    it('rejects an invalid reason', () => {
      const bad = {
        toolCallId: 'tc-003',
        toolName: 'foo',
        reason: 'unknown-reason',
        closedAt: new Date().toISOString(),
        originalStartedAt: new Date().toISOString(),
      }
      expect(() => SyntheticToolResultSchema.parse(bad)).toThrow()
    })
  })

  describe('SessionService tool closure tracking', () => {
    let sessionService: SessionService

    beforeEach(() => {
      sessionService = new SessionService(':memory:')
    })

    it('records a tool closure and marks it as closed', () => {
      const session = sessionService.createSession('test-scenario')
      const recorded = sessionService.recordToolClosure(session.id, 'tc-100', 'fetchData', 'timeout')
      expect(recorded).toBe(true)
      expect(sessionService.isToolCallClosed(session.id, 'tc-100')).toBe(true)
    })

    it('is idempotent — duplicate closure returns false', () => {
      const session = sessionService.createSession('test-scenario')
      sessionService.recordToolClosure(session.id, 'tc-dup', 'fetchData', 'timeout')
      const second = sessionService.recordToolClosure(session.id, 'tc-dup', 'fetchData', 'timeout')
      expect(second).toBe(false)
    })

    it('records an info event for each closure', () => {
      const session = sessionService.createSession('test-scenario')
      sessionService.recordToolClosure(session.id, 'tc-evt', 'deploy', 'interruption')
      const updated = sessionService.getSession(session.id)!
      const closureEvents = updated.events.filter(
        (e) => e.type === 'info' && (e.payload as Record<string, unknown>)?.['event'] === 'tool_synthetic_closure',
      )
      expect(closureEvents).toHaveLength(1)
      expect((closureEvents[0]!.payload as Record<string, unknown>)?.['reason']).toBe('interruption')
    })

    it('returns false for unclosed tool calls', () => {
      const session = sessionService.createSession('test-scenario')
      expect(sessionService.isToolCallClosed(session.id, 'tc-never')).toBe(false)
    })
  })

  describe('AgentRuntime.closePendingToolCalls', () => {
    let sessionService: SessionService
    let toolRegistry: ToolRegistry
    let runtime: AgentRuntime

    beforeEach(() => {
      sessionService = new SessionService(':memory:')
      toolRegistry = new ToolRegistry()
      runtime = new AgentRuntime(undefined, toolRegistry, sessionService)
    })

    it('closes pending tool calls with timeout reason', async () => {
      const slowHandler: ToolHandler = async () => {
        await new Promise((r) => setTimeout(r, 50))
        return { ok: true, output: {} }
      }
      toolRegistry.register('slowOp', slowHandler, makeMetadata('slowOp'))

      const session = sessionService.createSession('test-scenario')

      const provider: ModelProvider = {
        async chat(): Promise<ModelResponse> {
          return {
            toolCalls: [{ id: 'tc-slow', name: 'slowOp', input: {} }],
            stopReason: 'tool_use',
          }
        },
      }

      const runtimeWithProvider = new AgentRuntime(provider, toolRegistry, sessionService)
      runtimeWithProvider.registerAgent(makeProfile({ timeoutMs: 1 }))

      const result = await runtimeWithProvider.executeStep(
        makeProfile({ timeoutMs: 1 }),
        { sessionId: session.id, messages: [{ role: 'user', content: 'test' }] },
      )

      expect(result.status).toBe('timeout')
    })

    it('closePendingToolCalls is idempotent', () => {
      const session = sessionService.createSession('test-scenario')
      // Manually record a closure, then try again
      sessionService.recordToolClosure(session.id, 'tc-already', 'op', 'timeout')

      // closePendingToolCalls with no pending calls returns empty
      const results = runtime.closePendingToolCalls(session.id, 'timeout')
      expect(results).toHaveLength(0)
    })

    it('returns empty array when no session service is configured', () => {
      const runtimeNoService = new AgentRuntime()
      const results = runtimeNoService.closePendingToolCalls('any-session', 'interruption')
      expect(results).toHaveLength(0)
    })
  })
})
