import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentRuntime, type StepContext } from '../services/agent-runtime.js'
import { ToolRegistry } from '../services/tool-registry.js'
import { createSessionServiceStub } from '../services/session-service.js'
import type { ModelProvider, AgentProfile, ModelResponse } from '../types/agent-types.js'
import type { SessionService } from '../services/session-service.js'

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    role: 'sales_associate',
    model: 'claude-haiku-4-5-20251001',
    timeoutMs: 30000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    toolPolicy: { browserAccess: true },
    evidencePolicy: { requireScreenshotForFinding: true, requireDomSnippetForFinding: false },
    canBlockRun: false,
    ...overrides,
  }
}

function makeStepContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    sessionId: 'sess-1',
    messages: [{ role: 'user', content: 'Create a customer named Alex' }],
    ...overrides,
  }
}

function mockProvider(responses: ModelResponse[]): ModelProvider {
  let callIndex = 0
  return {
    chat: vi.fn(async () => {
      const response = responses[callIndex]
      if (!response) throw new Error('No more mock responses')
      callIndex++
      return response
    }),
  }
}

describe('AgentRuntime', () => {
  let registry: ToolRegistry
  let sessionService: SessionService

  beforeEach(() => {
    registry = new ToolRegistry()
    sessionService = createSessionServiceStub()
  })

  describe('executeStep — simple text response', () => {
    it('returns completed with text when model has no tool calls', async () => {
      const provider = mockProvider([{
        text: 'Customer created successfully.',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      }])

      const runtime = new AgentRuntime(provider, registry, sessionService)
      const result = await runtime.executeStep(makeProfile(), makeStepContext())

      expect(result.status).toBe('completed')
      expect(result.text).toBe('Customer created successfully.')
      expect(result.toolCalls).toEqual([])
    })
  })

  describe('executeStep — tool execution loop', () => {
    it('executes tool calls and feeds results back to model', async () => {
      registry.register('echo', async (input) => ({ ok: true, output: input }), {
        name: 'echo',
        description: 'Echo input',
        requiresBrowser: false,
        tags: [],
      })

      const provider = mockProvider([
        {
          text: 'I will echo.',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { msg: 'hello' } }],
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 8 },
        },
        {
          text: 'Done echoing.',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 20, outputTokens: 5 },
        },
      ])

      const runtime = new AgentRuntime(provider, registry, sessionService)
      const result = await runtime.executeStep(makeProfile(), makeStepContext())

      expect(result.status).toBe('completed')
      expect(result.text).toBe('Done echoing.')
      expect(result.output).toEqual({ msg: 'hello' })
      expect(provider.chat).toHaveBeenCalledTimes(2)
    })

    it('scopes execution to the step capability when running a scenario step', async () => {
      registry.register('expectedTool', async () => ({ ok: true, output: { commandResult: { completed: true } } }), {
        name: 'expectedTool',
        description: 'Expected tool',
        requiresBrowser: false,
        tags: [],
      })
      registry.register('otherTool', async () => ({ ok: true, output: { wrong: true } }), {
        name: 'otherTool',
        description: 'Other tool',
        requiresBrowser: false,
        tags: [],
      })

      const provider = mockProvider([{
        text: 'Using the scoped capability.',
        toolCalls: [{ id: 'call-1', name: 'expectedTool', input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 8 },
      }, {
        text: 'done',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 20, outputTokens: 4 },
      }])

      const runtime = new AgentRuntime(provider, registry, sessionService)
      runtime.registerAgent(makeProfile({
        id: 'sales_associate',
        toolPolicy: { browserAccess: false, allowedTools: ['expectedTool', 'otherTool'] },
        evidencePolicy: { requireScreenshotForFinding: false, requireDomSnippetForFinding: false },
      }))

      const result = await runtime.executeStep('sales_associate', {
        id: 'step_1',
        name: 'Expected step',
        agentId: 'sales_associate',
        capabilityId: 'expectedTool',
        order: 1,
        requiredArtifacts: [],
        producedArtifacts: ['commandResult'],
      }, { sessionId: 'sess-1' })

      expect(result.status).toBe('completed')
      expect(result.output).toEqual({
        commandResult: {
          completed: true,
        },
      })
      expect(vi.mocked(provider.chat).mock.calls[0]?.[1]).toEqual([
        expect.objectContaining({ name: 'expectedTool' }),
      ])
    })
  })

  describe('executeStep — session events', () => {
    it('emits tool_call and tool_result events', async () => {
      const appendEventSpy = vi.spyOn(sessionService, 'appendEvent')

      registry.register('noop', async () => ({ ok: true, output: null }), {
        name: 'noop',
        description: 'No-op',
        requiresBrowser: false,
        tags: [],
      })

      const provider = mockProvider([
        {
          toolCalls: [{ id: 'c1', name: 'noop', input: {} }],
          stopReason: 'tool_use',
          usage: { inputTokens: 5, outputTokens: 3 },
        },
        {
          text: 'done',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 2 },
        },
      ])

      const runtime = new AgentRuntime(provider, registry, sessionService)
      await runtime.executeStep(makeProfile(), makeStepContext())

      const eventTypes = appendEventSpy.mock.calls.map((c) => c[1].type)
      expect(eventTypes).toContain('tool_call')
      expect(eventTypes).toContain('tool_result')
      expect(eventTypes).toContain('info') // model_response event
    })
  })

  describe('executeStep — provider model remapping', () => {
    it('remaps anthropic profile models when provider is openai', async () => {
      const provider = mockProvider([{
        text: 'Customer created successfully.',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      }])

      const runtime = new AgentRuntime(provider, registry, sessionService, undefined, 'openai')
      await runtime.executeStep(makeProfile(), makeStepContext())

      expect(provider.chat).toHaveBeenCalledTimes(1)
      expect(vi.mocked(provider.chat).mock.calls[0]?.[2]).toMatchObject({
        model: 'gpt-4.1-mini',
      })
    })
  })

  describe('executeStep — L5 runtime learning overlays', () => {
    // A scenario step needs its capability registered as a tool; without it the step now fails
    // before calling the model (S-05), and these tests are about the prompt the model receives.
    beforeEach(() => {
      registry.register('registerCustomer', async () => ({ ok: true, output: { customerId: 'cust-1' } }), {
        name: 'registerCustomer',
        description: 'Register a customer',
        requiresBrowser: false,
        tags: [],
      })
    })

    it('consults retained L5 learning signals scoped to scenario, step, and agent', async () => {
      const session = sessionService.createSession('first_order')
      const signal = sessionService.recordL5LearningSignal({
        sourceType: 'independent_audit_review',
        sourceId: 'review-create-customer',
        signalType: 'audit_reviewed',
        sourceRunId: 'loop-create-customer',
        scenarioId: 'first_order',
        stepId: 'register_customer',
        agentId: 'sales_associate',
        version: 'audit_reviewed:loop-create-customer:review-create-customer',
        confidence: 0.86,
        summary: 'Prior audit accepted the customer id extraction risk and requires URL confirmation.',
        evidence: { auditVerdict: 'warning' },
      })

      const provider = mockProvider([{
        text: 'Customer created successfully.',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      }])
      const runtime = new AgentRuntime(provider, registry, sessionService)
      runtime.registerAgent(makeProfile({
        id: 'sales_associate',
        evidencePolicy: { requireScreenshotForFinding: false, requireDomSnippetForFinding: false },
      }))

      await runtime.executeStep('sales_associate', {
        id: 'register_customer',
        name: 'Create customer',
        agentId: 'sales_associate',
        capabilityId: 'registerCustomer',
        order: 1,
        requiredArtifacts: [],
        producedArtifacts: ['customerId'],
      }, { sessionId: session.id })

      const messages = vi.mocked(provider.chat).mock.calls[0]![0]
      const systemMessage = messages.find((message) => message.role === 'system')?.content ?? ''
      expect(systemMessage).toContain('[L5 LEARNING MEMORY]')
      expect(systemMessage).toContain('advisory only')
      expect(systemMessage).toContain('Prior audit accepted the customer id extraction risk')
      expect(systemMessage).toContain(`Version: ${signal.version}`)
      expect(systemMessage).toContain('Confidence: 0.86')
      expect(systemMessage).toContain('Scope: scenario=first_order, step=register_customer, agent=sales_associate')

      const events = sessionService.getSession(session.id)?.events ?? []
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'info',
          payload: expect.objectContaining({
            event: 'l5_learning_signals_loaded',
            scenarioId: 'first_order',
            stepId: 'register_customer',
            signalCount: 1,
            signals: [expect.objectContaining({ id: signal.id, signalType: 'audit_reviewed' })],
          }),
        }),
      ]))
    })

    it('ignores superseded or out-of-scope L5 learning signals', async () => {
      const session = sessionService.createSession('first_order')
      sessionService.recordL5LearningSignal({
        sourceType: 'independent_audit_review',
        sourceId: 'review-stale',
        signalType: 'audit_reviewed',
        sourceRunId: 'loop-runtime-filter',
        scenarioId: 'first_order',
        stepId: 'register_customer',
        agentId: 'sales_associate',
        version: 'audit_reviewed:loop-runtime-filter:review-stale',
        confidence: 0.2,
        summary: 'Stale signal must not reach the model.',
      })
      sessionService.recordL5LearningSignal({
        sourceType: 'independent_audit_review',
        sourceId: 'review-current',
        signalType: 'audit_reviewed',
        sourceRunId: 'loop-runtime-filter',
        scenarioId: 'first_order',
        stepId: 'register_customer',
        agentId: 'sales_associate',
        version: 'audit_reviewed:loop-runtime-filter:review-current',
        confidence: 0.9,
        summary: 'Current retained signal should reach the model.',
      })
      sessionService.recordL5LearningSignal({
        sourceType: 'independent_audit_review',
        sourceId: 'review-other-step',
        signalType: 'audit_reviewed',
        sourceRunId: 'loop-other-step',
        scenarioId: 'first_order',
        stepId: 'fulfill_order',
        agentId: 'sales_associate',
        version: 'audit_reviewed:loop-other-step:review-other-step',
        confidence: 0.9,
        summary: 'Other step signal must not reach the model.',
      })
      sessionService.recordL5LearningSignal({
        sourceType: 'knowledge_promotion',
        sourceId: 'promotion-other-agent',
        signalType: 'promotion_verified',
        sourceRunId: 'loop-other-agent',
        scenarioId: 'first_order',
        stepId: 'register_customer',
        agentId: 'fulfillment_agent',
        version: 'promotion_verified:loop-other-agent:promotion-other-agent',
        confidence: 0.9,
        summary: 'Other agent signal must not reach the model.',
      })

      const provider = mockProvider([{
        text: 'Customer created successfully.',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      }])
      const runtime = new AgentRuntime(provider, registry, sessionService)
      runtime.registerAgent(makeProfile({
        id: 'sales_associate',
        evidencePolicy: { requireScreenshotForFinding: false, requireDomSnippetForFinding: false },
      }))

      await runtime.executeStep('sales_associate', {
        id: 'register_customer',
        name: 'Create customer',
        agentId: 'sales_associate',
        capabilityId: 'registerCustomer',
        order: 1,
        requiredArtifacts: [],
        producedArtifacts: ['customerId'],
      }, { sessionId: session.id })

      const messages = vi.mocked(provider.chat).mock.calls[0]![0]
      const systemMessage = messages.find((message) => message.role === 'system')?.content ?? ''
      expect(systemMessage).toContain('Current retained signal should reach the model.')
      expect(systemMessage).not.toContain('Stale signal must not reach the model.')
      expect(systemMessage).not.toContain('Other step signal must not reach the model.')
      expect(systemMessage).not.toContain('Other agent signal must not reach the model.')
    })

    it('injects active verified L5 overlays scoped to scenario, step, and agent', async () => {
      const session = sessionService.createSession('first_order')
      const proposal = sessionService.createLearningProposal({
        recommendationId: 'runtime-overlay-create-customer',
        scenarioId: 'first_order',
        stepId: 'register_customer',
        agentId: 'sales_associate',
        type: 'prompt_patch',
        severity: 'medium',
        recommendation: { reason: 'previous run failed to persist customer id' },
        patchKind: 'prompt_overlay',
        target: 'agent:sales_associate',
        patchContent: 'Before reporting success, confirm the customer id is present in the current URL or tool output.',
      })
      sessionService.updateLearningProposalStatus(proposal.id, 'approved')
      const applied = sessionService.updateLearningProposalStatus(proposal.id, 'applied')!
      sessionService.recordL5Materialization({
        subjectType: 'learning_proposal',
        subjectId: applied.id,
        kind: 'learning_prompt_overlay',
        filePath: 'l5/learning-overlays/runtime-overlay-create-customer.md',
        checksum: 'runtime-overlay-checksum',
        metadata: {
          scenarioId: 'first_order',
          stepId: 'register_customer',
          agentId: 'sales_associate',
          target: 'agent:sales_associate',
          independentAudit: { verdict: 'passed' },
          postWriteVerification: { checksumMatches: true },
        },
      })

      const provider = mockProvider([{
        text: 'Customer created successfully.',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      }])
      const runtime = new AgentRuntime(provider, registry, sessionService)
      runtime.registerAgent(makeProfile({
        id: 'sales_associate',
        evidencePolicy: { requireScreenshotForFinding: false, requireDomSnippetForFinding: false },
      }))

      await runtime.executeStep('sales_associate', {
        id: 'register_customer',
        name: 'Create customer',
        agentId: 'sales_associate',
        capabilityId: 'registerCustomer',
        order: 1,
        requiredArtifacts: [],
        producedArtifacts: ['customerId'],
      }, { sessionId: session.id })

      const messages = vi.mocked(provider.chat).mock.calls[0]![0]
      const systemMessage = messages.find((message) => message.role === 'system')?.content ?? ''
      expect(systemMessage).toContain('[APPLIED L5 RUNTIME LEARNING]')
      expect(systemMessage).toContain('approved, materialized, audited')
      expect(systemMessage).toContain('Before reporting success, confirm the customer id')
      expect(systemMessage).toContain(`Proposal: ${applied.id}`)
      expect(systemMessage).toContain('Checksum: runtime-overlay-checksum')

      const events = sessionService.getSession(session.id)?.events ?? []
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'info',
          payload: expect.objectContaining({
            event: 'l5_runtime_learning_loaded',
            overlayCount: 1,
            stepId: 'register_customer',
          }),
        }),
      ]))
    })

    it('ignores applied prompt overlays that were not materialized and verified by L5', async () => {
      const session = sessionService.createSession('first_order')
      const proposal = sessionService.createLearningProposal({
        recommendationId: 'runtime-overlay-without-materialization',
        scenarioId: 'first_order',
        stepId: 'register_customer',
        agentId: 'sales_associate',
        type: 'prompt_patch',
        severity: 'medium',
        recommendation: { reason: 'candidate learning only' },
        patchKind: 'prompt_overlay',
        target: 'agent:sales_associate',
        patchContent: 'This unmaterialized overlay must not reach the model.',
      })
      sessionService.updateLearningProposalStatus(proposal.id, 'applied')

      const provider = mockProvider([{
        text: 'Customer created successfully.',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      }])
      const runtime = new AgentRuntime(provider, registry, sessionService)
      runtime.registerAgent(makeProfile({
        id: 'sales_associate',
        evidencePolicy: { requireScreenshotForFinding: false, requireDomSnippetForFinding: false },
      }))

      await runtime.executeStep('sales_associate', {
        id: 'register_customer',
        name: 'Create customer',
        agentId: 'sales_associate',
        capabilityId: 'registerCustomer',
        order: 1,
        requiredArtifacts: [],
        producedArtifacts: ['customerId'],
      }, { sessionId: session.id })

      const messages = vi.mocked(provider.chat).mock.calls[0]![0]
      const systemMessage = messages.find((message) => message.role === 'system')?.content ?? ''
      expect(systemMessage).not.toContain('[APPLIED L5 RUNTIME LEARNING]')
      expect(systemMessage).not.toContain('This unmaterialized overlay must not reach the model.')
    })
  })

  describe('executeStep — timeout', () => {
    it('returns timeout when execution exceeds timeoutMs', async () => {
      const provider: ModelProvider = {
        chat: vi.fn(async () => {
          // Simulate slow model call
          await new Promise((r) => setTimeout(r, 50))
          return {
            text: 'still thinking',
            toolCalls: [{ id: 'c1', name: 'slow', input: {} }],
            stopReason: 'tool_use' as const,
            usage: { inputTokens: 5, outputTokens: 3 },
          }
        }),
      }

      registry.register('slow', async () => {
        await new Promise((r) => setTimeout(r, 50))
        return { ok: true, output: null }
      }, { name: 'slow', description: 'Slow tool', requiresBrowser: false, tags: [] })

      const runtime = new AgentRuntime(provider, registry, sessionService)
      const result = await runtime.executeStep(
        makeProfile({ timeoutMs: 10 }), // very short timeout
        makeStepContext(),
      )

      expect(result.status).toBe('timeout')
      expect(result.error).toContain('timeout')
    })

    it('completes from tool output when required produced artifacts exist', async () => {
      registry.register('registerCustomer', async () => ({
        ok: true,
        output: { customerId: 'customer-1', customerName: 'Maria' },
      }), {
        name: 'registerCustomer',
        description: 'Create customer',
        requiresBrowser: true,
        tags: [],
      })

      const provider: ModelProvider = {
        chat: vi.fn(async () => ({
          toolCalls: [{ id: 'c1', name: 'registerCustomer', input: { name: 'Maria' } }],
          stopReason: 'tool_use' as const,
          usage: { inputTokens: 5, outputTokens: 3 },
        })),
      }
      vi.mocked(provider.chat).mockImplementationOnce(async () => ({
        toolCalls: [{ id: 'c1', name: 'registerCustomer', input: { name: 'Maria' } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 5, outputTokens: 3 },
      }))
      vi.mocked(provider.chat).mockImplementationOnce(async () => new Promise(() => {}))

      const runtime = new AgentRuntime(provider, registry, sessionService)
      runtime.registerAgent(makeProfile({
        id: 'sales_associate',
        timeoutMs: 500,
        toolPolicy: { browserAccess: true, allowedTools: ['registerCustomer'] },
        evidencePolicy: { requireScreenshotForFinding: false, requireDomSnippetForFinding: false },
      }))

      const result = await runtime.executeStep('sales_associate', {
        id: 'register_customer',
        name: 'Create customer',
        agentId: 'sales_associate',
        capabilityId: 'registerCustomer',
        order: 1,
        requiredArtifacts: [],
        producedArtifacts: ['customerId'],
      }, { sessionId: 'sess-1' })

      expect(result.status).toBe('completed')
      expect(result.success).toBe(true)
      expect(result.output).toMatchObject({ customerId: 'customer-1' })
      expect(provider.chat).toHaveBeenCalledTimes(1)
    })
  })

  describe('executeStep — policy enforcement', () => {
    it('filters tools based on agent tool policy', async () => {
      registry.register('allowed', async () => ({ ok: true, output: 'yes' }), {
        name: 'allowed',
        description: 'Allowed tool',
        requiresBrowser: false,
        tags: [],
      })
      registry.register('denied', async () => ({ ok: true, output: 'no' }), {
        name: 'denied',
        description: 'Denied tool',
        requiresBrowser: false,
        tags: [],
      })

      const provider = mockProvider([{
        text: 'ok',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 2 },
      }])

      const profile = makeProfile({
        toolPolicy: { allowedTools: ['allowed'], browserAccess: false },
      })

      const runtime = new AgentRuntime(provider, registry, sessionService)
      await runtime.executeStep(profile, makeStepContext())

      // Check that only 'allowed' tool was passed to provider
      const chatCall = vi.mocked(provider.chat).mock.calls[0]!
      const toolNames = (chatCall[1] as Array<{ name: string }>).map((t) => t.name)
      expect(toolNames).toEqual(['allowed'])
    })
  })

  describe('validateFindingEvidence', () => {
    it('rejects finding without screenshot when policy requires it', () => {
      const runtime = new AgentRuntime(
        mockProvider([]),
        registry,
        sessionService,
      )
      const profile = makeProfile({
        evidencePolicy: { requireScreenshotForFinding: true, requireDomSnippetForFinding: false },
      })

      const result = runtime.validateFindingEvidence(profile, [])
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('screenshot')
    })

    it('accepts finding with evidence', () => {
      const runtime = new AgentRuntime(
        mockProvider([]),
        registry,
        sessionService,
      )
      const profile = makeProfile({
        evidencePolicy: { requireScreenshotForFinding: true, requireDomSnippetForFinding: false },
      })

      const result = runtime.validateFindingEvidence(profile, ['artifact-1'])
      expect(result.valid).toBe(true)
    })
  })

  describe('executeStep — model error', () => {
    it('returns failed when model throws', async () => {
      const provider: ModelProvider = {
        chat: vi.fn(async () => { throw new Error('API rate limited') }),
      }

      const runtime = new AgentRuntime(provider, registry, sessionService)
      const result = await runtime.executeStep(makeProfile(), makeStepContext())

      expect(result.status).toBe('failed')
      expect(result.error).toContain('rate limited')
    })
  })
})
