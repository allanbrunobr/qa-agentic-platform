import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicProvider } from '../providers/anthropic-provider.js'
import { OpenAIProvider } from '../providers/openai-provider.js'
import { AgentRuntime } from '../services/agent-runtime.js'
import { createSessionServiceStub } from '../services/session-service.js'
import { ToolRegistry } from '../services/tool-registry.js'
import { registerEvidenceTools } from '../tools/evidence-tools.js'
import { registerGeneratedAdapterTools } from '../tools/generated-adapter-tools.js'
import type { AgentProfile, ModelProvider, ModelProviderOptions, ModelResponse } from '../types/agent-types.js'
import type { ToolContext } from '../types/tool-types.js'

// B-06 (docs/analise-20261109.md): a step timeout was only a Promise.race. The tool and the model
// call kept running after the step was marked timed out, so an orphan tool could keep driving the
// shared page and store artifacts into a step that had already ended.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const anthropicCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate }
  },
}))

afterEach(() => {
  vi.unstubAllGlobals()
  anthropicCreate.mockReset()
})

function profile(timeoutMs: number): AgentProfile {
  return {
    role: 'probe',
    model: 'test-model',
    timeoutMs,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    toolPolicy: { browserAccess: true },
    evidencePolicy: { requireScreenshotForFinding: false, requireDomSnippetForFinding: false },
    canBlockRun: false,
  }
}

describe('step cancellation', () => {
  it('aborts the running tool when the step times out', async () => {
    const seen: { context?: ToolContext; abortedWhenDone?: boolean } = {}
    const registry = new ToolRegistry()
    registry.register('slowTool', async (_input, context) => {
      seen.context = context
      await sleep(400)
      seen.abortedWhenDone = context.signal?.aborted
      return { ok: true, output: {} }
    }, { name: 'slowTool', description: 'slow', requiresBrowser: false, tags: [] })
    const responses: ModelResponse[] = [{ text: '', toolCalls: [{ id: 't', name: 'slowTool', input: {} }], stopReason: 'tool_use' }]
    let index = 0
    const provider: ModelProvider = { chat: vi.fn(async () => responses[index++] ?? { text: 'done', toolCalls: [], stopReason: 'end_turn' as const }) }
    const sessionService = createSessionServiceStub()
    const session = sessionService.createSession('probe')

    const result = await new AgentRuntime(provider, registry, sessionService)
      .executeStep(profile(150), { sessionId: session.id, messages: [{ role: 'user', content: 'go' }] })

    expect(result.status).toBe('timeout')
    expect(seen.context?.signal).toBeDefined()
    expect(seen.context?.signal?.aborted).toBe(true)
    await sleep(350)
    expect(seen.abortedWhenDone).toBe(true)
  })

  it('aborts the model call when the step times out', async () => {
    let options: ModelProviderOptions | undefined
    const provider: ModelProvider = {
      chat: vi.fn(async (_messages: unknown, _tools: unknown, received?: ModelProviderOptions): Promise<ModelResponse> => {
        options = received
        await sleep(400)
        return { text: 'late', toolCalls: [], stopReason: 'end_turn' }
      }),
    }
    const sessionService = createSessionServiceStub()
    const session = sessionService.createSession('probe')
    const result = await new AgentRuntime(provider, new ToolRegistry(), sessionService)
      .executeStep(profile(150), { sessionId: session.id, messages: [{ role: 'user', content: 'go' }] })

    expect(result.status).toBe('timeout')
    expect(options?.signal).toBeDefined()
    expect(options?.signal?.aborted).toBe(true)
  })

  it('aborts the signal once a step finishes normally, so late work cannot act for it', async () => {
    let signal: AbortSignal | undefined
    const registry = new ToolRegistry()
    registry.register('quickTool', async (_input, context) => {
      signal = context.signal
      return { ok: true, output: { done: true } }
    }, { name: 'quickTool', description: 'quick', requiresBrowser: false, tags: [] })
    const responses: ModelResponse[] = [
      { text: '', toolCalls: [{ id: 'q', name: 'quickTool', input: {} }], stopReason: 'tool_use' },
      { text: 'done', toolCalls: [], stopReason: 'end_turn' },
    ]
    let index = 0
    const provider: ModelProvider = { chat: vi.fn(async () => responses[index++]!) }
    const sessionService = createSessionServiceStub()
    const session = sessionService.createSession('probe')
    const result = await new AgentRuntime(provider, registry, sessionService)
      .executeStep(profile(5000), { sessionId: session.id, messages: [{ role: 'user', content: 'go' }] })

    expect(result.status).toBe('completed')
    expect(signal?.aborted).toBe(true)
  })

  it('evidence tools refuse to store an artifact after the step was aborted', async () => {
    const sessionService = createSessionServiceStub()
    const session = sessionService.createSession('probe')
    const registry = new ToolRegistry()
    registerEvidenceTools(registry, sessionService)
    const controller = new AbortController()
    controller.abort()
    const page = { screenshot: async () => Buffer.from('png'), url: () => 'http://127.0.0.1/x' }

    const result = await registry.execute('captureScreenshot', { description: 'late' }, { browserAccess: true }, {
      page, sessionId: session.id, signal: controller.signal,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('step_aborted')
    expect(Object.keys(sessionService.getSession(session.id)?.artifacts ?? {})).toEqual([])
  })

  it('generated browser tools refuse to act on the page after the step was aborted', async () => {
    const registry = new ToolRegistry()
    registerGeneratedAdapterTools(registry)
    const controller = new AbortController()
    controller.abort()
    const visited: string[] = []
    const page = { goto: async (url: string) => { visited.push(url) }, url: () => 'about:blank' }

    const result = await registry.execute('openPrimaryRoute', {}, { browserAccess: true, allowedTools: ['openPrimaryRoute'] }, {
      page, signal: controller.signal, executionTarget: { baseUrl: 'http://127.0.0.1:4000' },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('step_aborted')
    expect(visited).toEqual([])
  })

  it('generated browser tools stop touching the page when the step ends while they run', async () => {
    const registry = new ToolRegistry()
    registerGeneratedAdapterTools(registry)
    const controller = new AbortController()
    const visited: string[] = []
    // fillCustomerEmail reads page.url() to see whether it must navigate first. The step times out
    // during that read, so the navigation (and the fill after it) must not happen.
    const page = {
      goto: async (url: string) => { visited.push(url) },
      url: () => { controller.abort(); return 'about:blank' },
      locator: () => ({ fill: async () => { visited.push('fill') } }),
    }

    const result = await registry.execute('fillCustomerEmail', {}, { browserAccess: true, allowedTools: ['fillCustomerEmail'] }, {
      page, signal: controller.signal, executionTarget: { baseUrl: 'http://127.0.0.1:4000' },
    })

    expect(controller.signal.aborted).toBe(true)
    expect(visited).toEqual([])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('step_aborted')
  })

  it('a locator taken before the step ended cannot act after it ended', async () => {
    const registry = new ToolRegistry()
    registerGeneratedAdapterTools(registry)
    const controller = new AbortController()
    const filled: string[] = []
    // The page is already on the target, so no navigation. The step times out while the tool checks
    // the locator it already holds; the fill on that same locator must be refused.
    const page = {
      url: () => 'http://127.0.0.1:4000/checkout',
      locator: () => ({
        count: async () => { controller.abort(); return 1 },
        fill: async (value: string) => { filled.push(value) },
      }),
    }

    const result = await registry.execute('fillCustomerEmail', {}, { browserAccess: true, allowedTools: ['fillCustomerEmail'] }, {
      page, signal: controller.signal, executionTarget: { baseUrl: 'http://127.0.0.1:4000' },
    })

    expect(controller.signal.aborted).toBe(true)
    expect(filled).toEqual([])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('step_aborted')
  })

  it('the Anthropic provider hands the step signal to the SDK request', async () => {
    anthropicCreate.mockResolvedValue({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } })
    const controller = new AbortController()

    await new AnthropicProvider({ apiKey: 'unused', model: 'm' })
      .chat([{ role: 'user', content: 'hi' }], [], { signal: controller.signal })

    expect(anthropicCreate.mock.calls[0]?.[1]).toEqual({ signal: controller.signal })
  })

  it('the OpenAI provider hands the step signal to fetch', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] })))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await new OpenAIProvider({ apiKey: 'unused', model: 'm', baseUrl: 'http://127.0.0.1:9' })
      .chat([{ role: 'user', content: 'hi' }], [], { signal: controller.signal })

    const init = (fetchMock.mock.calls[0] as unknown[] | undefined)?.[1] as RequestInit | undefined
    expect(init?.signal).toBe(controller.signal)
  })
})
