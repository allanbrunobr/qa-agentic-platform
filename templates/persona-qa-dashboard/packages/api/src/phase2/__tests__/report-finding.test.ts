import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../services/agent-runtime.js'
import { createPhase2Runtime } from '../services/runtime-bootstrap.js'
import { createSessionServiceStub, type SessionService } from '../services/session-service.js'
import { ToolRegistry } from '../services/tool-registry.js'
import { registerFindingTools } from '../tools/finding-tools.js'
import type { AgentProfile, ModelProvider, ModelResponse } from '../types/agent-types.js'

// B-04 (docs/analise-20261109.md): agents had no way to record a defect, so every run reported zero
// agent findings and the "finding needs a screenshot" policy never applied.

const STEP = {
  id: 'checkout',
  name: 'Checkout',
  agentId: 'shopper',
  capabilityId: 'submitOrder',
  order: 0,
  requiredArtifacts: [],
  producedArtifacts: [],
}

function profile(requireScreenshot: boolean): AgentProfile {
  return {
    id: 'shopper',
    role: 'shopper',
    model: 'test-model',
    timeoutMs: 30000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    toolPolicy: { browserAccess: true, allowedTools: ['submitOrder'] },
    evidencePolicy: { requireScreenshotForFinding: requireScreenshot, requireDomSnippetForFinding: false },
    canBlockRun: false,
  }
}

function setup(responses: ModelResponse[], requireScreenshot = true) {
  const registry = new ToolRegistry()
  registry.register('submitOrder', async () => ({ ok: true, output: { orderSubmitted: true } }), {
    name: 'submitOrder', description: 'submit', requiresBrowser: false, tags: [],
  })
  registry.register('captureScreenshot', async () => ({ ok: true, output: { artifactId: 'shot-1' } }), {
    name: 'captureScreenshot', description: 'screenshot', requiresBrowser: false, tags: [],
  })
  registerFindingTools(registry)
  const sessionService: SessionService = createSessionServiceStub()
  const session = sessionService.createSession('checkout_flow')
  let index = 0
  const provider: ModelProvider = { chat: vi.fn(async () => responses[index++] ?? { text: 'done', toolCalls: [], stopReason: 'end_turn' as const }) }
  const runtime = new AgentRuntime(provider, registry, sessionService)
  runtime.registerAgent(profile(requireScreenshot))
  return { runtime, provider, sessionService, sessionId: session.id }
}

const call = (id: string, name: string, input: unknown = {}): ModelResponse => ({ text: '', toolCalls: [{ id, name, input }], stopReason: 'tool_use' })
const end: ModelResponse = { text: 'done', toolCalls: [], stopReason: 'end_turn' }
const finding = (evidenceArtifactIds: string[] = []) => ({
  severity: 'high',
  title: 'Total ignores the discount',
  description: 'Applied SAVE10 and the order total stayed the same.',
  expected: 'Total reduced by 10%',
  actual: 'Total unchanged',
  evidenceArtifactIds,
})

function toolResults(sessionService: SessionService, sessionId: string, toolName: string) {
  return (sessionService.getSession(sessionId)?.events ?? [])
    .filter((event) => event.type === 'tool_result')
    .map((event) => (event.payload ?? event.data) as { toolName?: string; ok?: boolean; error?: { code?: string } })
    .filter((payload) => payload.toolName === toolName)
}

describe('reportFinding', () => {
  it('records a finding with a screenshot from this step and returns it in the step output', async () => {
    const { runtime, sessionService, sessionId } = setup([
      call('a', 'submitOrder'), call('b', 'captureScreenshot', { description: 'total' }), call('c', 'reportFinding', finding(['shot-1'])), end,
    ])
    const result = await runtime.executeStep('shopper', STEP, { sessionId })

    expect(result.status).toBe('completed')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toEqual(expect.objectContaining({ severity: 'high', title: 'Total ignores the discount', evidence: ['shot-1'] }))
    const stored = sessionService.getSession(sessionId)?.findings ?? []
    expect(stored).toHaveLength(1)
    expect(stored[0]).toEqual(expect.objectContaining({ title: 'Total ignores the discount', stepId: 'checkout', severity: 'high' }))
  })

  it('refuses a finding without evidence when the agent policy requires a screenshot', async () => {
    const { runtime, sessionService, sessionId } = setup([call('a', 'submitOrder'), call('c', 'reportFinding', finding()), end])
    const result = await runtime.executeStep('shopper', STEP, { sessionId })

    expect(result.findings).toEqual([])
    expect(sessionService.getSession(sessionId)?.findings ?? []).toEqual([])
    expect(toolResults(sessionService, sessionId, 'reportFinding')[0]).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'finding_without_evidence' }) }))
  })

  it('refuses evidence ids that were not captured in this step', async () => {
    const { runtime, sessionService, sessionId } = setup([call('a', 'submitOrder'), call('c', 'reportFinding', finding(['made-up-id'])), end])
    const result = await runtime.executeStep('shopper', STEP, { sessionId })
    expect(result.findings).toEqual([])
    expect(sessionService.getSession(sessionId)?.findings ?? []).toEqual([])
  })

  it('records a finding without evidence when the agent policy does not require it', async () => {
    const { runtime, sessionService, sessionId } = setup([call('a', 'submitOrder'), call('c', 'reportFinding', finding()), end], false)
    const result = await runtime.executeStep('shopper', STEP, { sessionId })
    expect(result.findings).toHaveLength(1)
    expect(sessionService.getSession(sessionId)?.findings ?? []).toHaveLength(1)
  })

  it('rejects an invalid finding input', async () => {
    const { runtime, sessionService, sessionId } = setup([call('a', 'submitOrder'), call('c', 'reportFinding', { severity: 'urgent', title: '' }), end], false)
    await runtime.executeStep('shopper', STEP, { sessionId })
    expect(toolResults(sessionService, sessionId, 'reportFinding')[0]).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'invalid_finding' }) }))
    expect(sessionService.getSession(sessionId)?.findings ?? []).toEqual([])
  })

  it('reporting a finding alone does not count as performing the step', async () => {
    const { runtime, sessionId } = setup([call('c', 'reportFinding', finding()), end], false)
    const result = await runtime.executeStep('shopper', STEP, { sessionId })
    expect(result.status).toBe('failed')
  })

  it('offers reportFinding and captureScreenshot next to the step capability', async () => {
    const { runtime, provider, sessionId } = setup([call('a', 'submitOrder'), end])
    await runtime.executeStep('shopper', STEP, { sessionId })
    const offered = (vi.mocked(provider.chat).mock.calls[0]?.[1] ?? []).map((tool) => tool.name).sort()
    expect(offered).toEqual(['captureScreenshot', 'reportFinding', 'submitOrder'])
  })

  // Pre-PR findings #4 and #5 (docs/p2-progresso.md).
  it('keeps expected and actual on the stored finding', async () => {
    const { runtime, sessionService, sessionId } = setup([
      call('a', 'submitOrder'), call('b', 'captureScreenshot', { description: 'total' }), call('c', 'reportFinding', finding(['shot-1'])), end,
    ])
    await runtime.executeStep('shopper', STEP, { sessionId })
    const stored = sessionService.getSession(sessionId)?.findings[0]
    expect(stored).toEqual(expect.objectContaining({ expected: 'Total reduced by 10%', actual: 'Total unchanged' }))
  })

  it('stores only the evidence ids that were captured in this step', async () => {
    const { runtime, sessionService, sessionId } = setup([
      call('a', 'submitOrder'), call('b', 'captureScreenshot', { description: 'total' }), call('c', 'reportFinding', finding(['shot-1', 'made-up-id'])), end,
    ])
    const result = await runtime.executeStep('shopper', STEP, { sessionId })
    expect(result.findings[0]?.evidence).toEqual(['shot-1'])
    expect(sessionService.getSession(sessionId)?.findings[0]?.evidence).toEqual(['shot-1'])
  })

  it('is registered by the runtime bootstrap', () => {
    const runtime = createPhase2Runtime({ deterministic: true, dbPath: ':memory:' } as never)
    expect(runtime.toolRegistry.has('reportFinding')).toBe(true)
  })
})
