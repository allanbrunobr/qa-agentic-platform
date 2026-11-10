import { describe, expect, it, vi } from 'vitest'
import { fromAnthropicResponse } from '../providers/anthropic-provider.js'
import { fromOpenAIResponse } from '../providers/openai-provider.js'
import { AgentRuntime } from '../services/agent-runtime.js'
import { createSessionServiceStub } from '../services/session-service.js'
import { ToolRegistry } from '../services/tool-registry.js'
import type { AgentProfile, ModelProvider, ModelResponse } from '../types/agent-types.js'

// B-03 (docs/analise-20261109.md): a scenario step must not pass just because the model stopped.
// A truncated or refused answer is a failure, and a scenario step needs at least one successful
// tool call: the verdict comes from what was done, not from the model going quiet.

function profile(): AgentProfile {
  return {
    id: 'probe_agent',
    role: 'probe_agent',
    model: 'test-model',
    timeoutMs: 30000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    toolPolicy: { browserAccess: false, allowedTools: ['doThing'] },
    evidencePolicy: { requireScreenshotForFinding: false, requireDomSnippetForFinding: false },
    canBlockRun: false,
  }
}

const STEP = {
  id: 'do_thing',
  name: 'Do thing',
  agentId: 'probe_agent',
  capabilityId: 'doThing',
  order: 0,
  requiredArtifacts: [],
  producedArtifacts: [],
}

function runtimeWith(responses: ModelResponse[], toolOk = true) {
  const registry = new ToolRegistry()
  registry.register('doThing', async () => (toolOk
    ? { ok: true, output: { done: true } }
    : { ok: false, error: { code: 'failed', message: 'nope', retryable: false } }), {
    name: 'doThing', description: 'does the thing', requiresBrowser: false, tags: [],
  })
  let index = 0
  const provider: ModelProvider = { chat: vi.fn(async () => responses[index++] ?? { text: 'done', toolCalls: [], stopReason: 'end_turn' }) }
  const runtime = new AgentRuntime(provider, registry, createSessionServiceStub())
  runtime.registerAgent(profile())
  return runtime
}

const callTool: ModelResponse = { text: '', toolCalls: [{ id: 't1', name: 'doThing', input: {} }], stopReason: 'tool_use' }

describe('scenario step completion', () => {
  it('fails a scenario step that ends without any tool call', async () => {
    const result = await runtimeWith([{ text: 'All good, nothing to do.', toolCalls: [], stopReason: 'end_turn' }])
      .executeStep('probe_agent', STEP, { sessionId: 's1' })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/without a successful tool call/)
  })

  it('fails a scenario step whose only tool call failed', async () => {
    const result = await runtimeWith([callTool, { text: 'done', toolCalls: [], stopReason: 'end_turn' }], false)
      .executeStep('probe_agent', STEP, { sessionId: 's2' })
    expect(result.status).toBe('failed')
  })

  it('fails a step when the model output was truncated (max_tokens)', async () => {
    const result = await runtimeWith([callTool, { text: 'I will now verify the ord', toolCalls: [], stopReason: 'max_tokens' }])
      .executeStep('probe_agent', STEP, { sessionId: 's3' })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/truncated/)
  })

  it('fails a step when the model refused', async () => {
    const result = await runtimeWith([callTool, { text: 'I cannot help with that.', toolCalls: [], stopReason: 'refusal' }])
      .executeStep('probe_agent', STEP, { sessionId: 's4' })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/refused/)
  })

  it('completes a scenario step after a successful tool call', async () => {
    const result = await runtimeWith([callTool, { text: 'done', toolCalls: [], stopReason: 'end_turn' }])
      .executeStep('probe_agent', STEP, { sessionId: 's5' })
    expect(result.status).toBe('completed')
  })
})

describe('provider stop reasons', () => {
  const anthropic = (stop_reason: string) => fromAnthropicResponse({
    id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'hi' }],
    stop_reason, usage: { input_tokens: 1, output_tokens: 1 },
  } as never).stopReason

  it('keeps refusals and unknown Anthropic stop reasons apart from a normal end', () => {
    expect(anthropic('end_turn')).toBe('end_turn')
    expect(anthropic('stop_sequence')).toBe('end_turn')
    expect(anthropic('max_tokens')).toBe('max_tokens')
    expect(anthropic('refusal')).toBe('refusal')
    expect(anthropic('pause_turn')).toBe('incomplete')
    expect(anthropic('something_new')).toBe('incomplete')
  })

  it('maps OpenAI content filtering to a refusal', () => {
    const openai = (finish_reason: string) => fromOpenAIResponse({
      choices: [{ message: { content: 'x' }, finish_reason }],
    } as never).stopReason
    expect(openai('stop')).toBe('end_turn')
    expect(openai('length')).toBe('max_tokens')
    expect(openai('content_filter')).toBe('refusal')
  })
})
