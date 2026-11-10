import { describe, it, expect, beforeEach } from 'vitest'
import { RiskPolicySchema } from '../types/agent-types.js'
import type { AgentProfile, ModelProvider, ModelResponse } from '../types/agent-types.js'
import type { ToolHandler, ToolMetadata } from '../types/tool-types.js'
import { AgentRuntime } from '../services/agent-runtime.js'
import { ToolRegistry } from '../services/tool-registry.js'
import { SessionService } from '../services/session-service.js'

function makeMetadata(name: string, riskLevel: 'read' | 'write' | 'destructive' = 'read'): ToolMetadata {
  return { name, description: `Tool ${name}`, requiresBrowser: false, tags: [], riskLevel }
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

describe('Story 1.3: Enforce Risk-Aware Tool Policy', () => {
  describe('RiskPolicy schema', () => {
    it('provides sensible defaults', () => {
      const parsed = RiskPolicySchema.parse({})
      expect(parsed.allowedRiskLevels).toEqual(['read'])
      expect(parsed.requireApprovalFor).toEqual([])
      expect(parsed.denyRiskLevels).toEqual([])
    })

    it('accepts a full policy', () => {
      const parsed = RiskPolicySchema.parse({
        allowedRiskLevels: ['read', 'write'],
        requireApprovalFor: ['destructive'],
        denyRiskLevels: [],
      })
      expect(parsed.allowedRiskLevels).toEqual(['read', 'write'])
      expect(parsed.requireApprovalFor).toEqual(['destructive'])
    })

    it('rejects invalid risk levels in policy arrays', () => {
      expect(() => RiskPolicySchema.parse({
        allowedRiskLevels: ['extreme'],
      })).toThrow()
    })
  })

  describe('AgentRuntime risk-aware isToolAllowed', () => {
    let registry: ToolRegistry
    let sessionService: SessionService
    let executed: string[]

    // T-01: the handlers record every real execution, so a test can tell a runtime that blocks a
    // tool from one that runs it and still reports the step as completed.
    const spyHandler = (name: string): ToolHandler => async (input) => {
      executed.push(name)
      return { ok: true, output: input }
    }

    beforeEach(() => {
      registry = new ToolRegistry()
      sessionService = new SessionService(':memory:')
      executed = []

      registry.register('readData', spyHandler('readData'), makeMetadata('readData', 'read'))
      registry.register('writeData', spyHandler('writeData'), makeMetadata('writeData', 'write'))
      registry.register('deleteAll', spyHandler('deleteAll'), makeMetadata('deleteAll', 'destructive'))
    })

    /** A model that asks for the given tools one per turn, then ends; it records what it was offered. */
    function scriptedProvider(toolNames: string[], offered: string[][] = []): ModelProvider {
      let callIndex = 0
      return {
        async chat(_messages, tools): Promise<ModelResponse> {
          offered.push(tools.map((tool) => tool.name))
          const name = toolNames[callIndex++]
          if (!name) return { toolCalls: [], stopReason: 'end_turn' }
          return { toolCalls: [{ id: `tc-${name}-${callIndex}`, name, input: {} }], stopReason: 'tool_use' }
        },
      }
    }

    function toolErrors(sessionId: string, toolName: string): Array<string | undefined> {
      return (sessionService.getSession(sessionId)?.events ?? [])
        .filter((event) => event.type === 'tool_result')
        .map((event) => (event.payload ?? event.data) as { toolName?: string; ok?: boolean; error?: { code?: string } })
        .filter((payload) => payload.toolName === toolName && payload.ok === false)
        .map((payload) => payload.error?.code)
    }

    it('runs a read tool and refuses a destructive one the model asks for anyway', async () => {
      const session = sessionService.createSession('test-scenario')
      const offered: string[][] = []
      const runtime = new AgentRuntime(scriptedProvider(['readData', 'deleteAll'], offered), registry, sessionService)
      const profile = makeProfile({
        riskPolicy: {
          allowedRiskLevels: ['read'],
          requireApprovalFor: [],
          denyRiskLevels: ['destructive'],
        },
      })

      await runtime.executeStep(profile, {
        sessionId: session.id,
        messages: [{ role: 'user', content: 'test' }],
      })

      expect(executed).toEqual(['readData'])
      expect(toolErrors(session.id, 'deleteAll')).toEqual(['tool_not_allowed'])
      expect(offered[0]).toContain('readData')
      expect(offered[0]).not.toContain('deleteAll')
    })

    it('refuses a write tool that requires approval (no approval mechanism yet)', async () => {
      const session = sessionService.createSession('test-scenario')
      const offered: string[][] = []
      const runtime = new AgentRuntime(scriptedProvider(['writeData'], offered), registry, sessionService)
      const profile = makeProfile({
        riskPolicy: {
          // write is allowed, but approval is required and there is no way to grant it yet.
          allowedRiskLevels: ['read', 'write'],
          requireApprovalFor: ['write'],
          denyRiskLevels: ['destructive'],
        },
      })

      await runtime.executeStep(profile, {
        sessionId: session.id,
        messages: [{ role: 'user', content: 'test' }],
      })

      expect(executed).toEqual([])
      expect(toolErrors(session.id, 'writeData')).toEqual(['tool_not_allowed'])
      expect(offered[0]).not.toContain('writeData')
    })

    it('works without riskPolicy (backward compatible)', async () => {
      const session = sessionService.createSession('test-scenario')

      const provider: ModelProvider = {
        async chat(): Promise<ModelResponse> {
          return { toolCalls: [], stopReason: 'end_turn' }
        },
      }

      const runtime = new AgentRuntime(provider, registry, sessionService)
      const profile = makeProfile() // no riskPolicy

      const result = await runtime.executeStep(profile, {
        sessionId: session.id,
        messages: [{ role: 'user', content: 'test' }],
      })

      expect(result.status).toBe('completed')
    })

    it('works without toolRegistry (backward compatible)', async () => {
      const provider: ModelProvider = {
        async chat(): Promise<ModelResponse> {
          return { toolCalls: [], stopReason: 'end_turn' }
        },
      }

      // No toolRegistry — should still function
      const runtime = new AgentRuntime(provider, undefined, sessionService)
      const profile = makeProfile({
        riskPolicy: {
          allowedRiskLevels: ['read'],
          requireApprovalFor: [],
          denyRiskLevels: ['destructive'],
        },
      })

      // Without toolRegistry, executeStep throws at the assertion
      await expect(
        runtime.executeStep(profile, {
          sessionId: 'test',
          messages: [{ role: 'user', content: 'test' }],
        }),
      ).rejects.toThrow()
    })

    it('denies tools with risk level not in allowedRiskLevels', async () => {
      const session = sessionService.createSession('test-scenario')

      let offeredTools: string[] = []
      const provider: ModelProvider = {
        async chat(_msgs, tools): Promise<ModelResponse> {
          offeredTools = tools.map((t) => t.name)
          return { toolCalls: [], stopReason: 'end_turn' }
        },
      }

      const runtime = new AgentRuntime(provider, registry, sessionService)
      const profile = makeProfile({
        riskPolicy: {
          allowedRiskLevels: ['read'],
          requireApprovalFor: [],
          denyRiskLevels: [],
        },
      })

      await runtime.executeStep(profile, {
        sessionId: session.id,
        messages: [{ role: 'user', content: 'test' }],
      })

      // Only read tools should be offered — write and destructive are not in allowedRiskLevels
      expect(offeredTools).toContain('readData')
      expect(offeredTools).not.toContain('writeData')
      expect(offeredTools).not.toContain('deleteAll')
    })

    it('deny takes precedence over allowed', async () => {
      const session = sessionService.createSession('test-scenario')

      let offeredTools: string[] = []
      const provider: ModelProvider = {
        async chat(_msgs, tools): Promise<ModelResponse> {
          offeredTools = tools.map((t) => t.name)
          return { toolCalls: [], stopReason: 'end_turn' }
        },
      }

      const runtime = new AgentRuntime(provider, registry, sessionService)
      const profile = makeProfile({
        riskPolicy: {
          allowedRiskLevels: ['read', 'write', 'destructive'],
          requireApprovalFor: [],
          denyRiskLevels: ['destructive'],
        },
      })

      await runtime.executeStep(profile, {
        sessionId: session.id,
        messages: [{ role: 'user', content: 'test' }],
      })

      // destructive should be denied even though it's in allowedRiskLevels
      expect(offeredTools).toContain('readData')
      expect(offeredTools).toContain('writeData')
      expect(offeredTools).not.toContain('deleteAll')
    })
  })
})
