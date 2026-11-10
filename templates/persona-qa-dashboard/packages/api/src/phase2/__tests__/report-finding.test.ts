import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../services/agent-runtime.js'
import { createPhase2Runtime } from '../services/runtime-bootstrap.js'
import { createSessionServiceStub, type SessionService } from '../services/session-service.js'
import { ToolRegistry } from '../services/tool-registry.js'
import {
  captureScreenshotMetadata,
  collectDomSnippetMetadata,
  makeCaptureScreenshotHandler,
  makeCollectDomSnippetHandler,
} from '../tools/evidence-tools.js'
import { registerFindingTools } from '../tools/finding-tools.js'
import type { AgentProfile, ModelProvider, ModelResponse } from '../types/agent-types.js'

// The real captureScreenshot handler writes under PHASE2_ARTIFACT_DIR, which session-service reads
// once, when it loads. vi.hoisted runs before the imports above, so no test writes into the repo.
const artifactDir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = mkdtempSync(path.join(tmpdir(), 'report-finding-artifacts-'))
  process.env['PHASE2_ARTIFACT_DIR'] = dir
  return dir
})
afterAll(() => rmSync(artifactDir, { recursive: true, force: true }))

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

  // Second pre-PR run, finding #3: support tools are offered in every step, so their output
  // (artifactId, filePath, sizeBytes, selector, htmlLength) must not become the step's output.
  it('does not turn the output of a support tool into step output', async () => {
    const { runtime, sessionId } = setup([
      call('b', 'captureScreenshot', { description: 'before' }), call('a', 'submitOrder'), end,
    ])
    const result = await runtime.executeStep('shopper', STEP, { sessionId })
    expect(result.output).toEqual({ orderSubmitted: true })
  })

  it('still counts a support tool output that carries an artifact the step declares', async () => {
    const { runtime, sessionId } = setup([call('b', 'captureScreenshot', { description: 'proof' }), end], false)
    const screenshotStep = { ...STEP, id: 'proof', capabilityId: 'captureScreenshot', producedArtifacts: ['artifactId'] }
    const result = await runtime.executeStep('shopper', screenshotStep, { sessionId })
    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ artifactId: 'shot-1' })
  })

  // Third pre-PR run, finding #4: the order the reportFinding description prescribes, in a step that
  // declares an artifact (every step discovery generates does): screenshot first, then the action and
  // the finding in the same response.
  it('records a finding in the prescribed order when the step declares an artifact', async () => {
    const { runtime, provider, sessionService, sessionId } = setup([
      call('b', 'captureScreenshot', { description: 'cart before checkout' }),
      { text: '', toolCalls: [{ id: 'a', name: 'submitOrder', input: {} }, { id: 'c', name: 'reportFinding', input: finding(['shot-1']) }], stopReason: 'tool_use' },
      end,
    ])
    const declaring = { ...STEP, producedArtifacts: ['orderSubmitted'] }
    const result = await runtime.executeStep('shopper', declaring, { sessionId })

    expect(result.status).toBe('completed')
    expect(vi.mocked(provider.chat).mock.calls).toHaveLength(2)
    expect(result.findings).toHaveLength(1)
    expect(sessionService.getSession(sessionId)?.findings[0]?.evidence).toEqual(['shot-1'])
  })

  // Third pre-PR run, finding #1: a profile without browser access (API or CLI target) is not offered
  // browser tools it would then be refused.
  it('offers no browser support tools to a profile without browser access', async () => {
    const registry = new ToolRegistry()
    registry.register('callHealthEndpoint', async () => ({ ok: true, output: { health: 'ok' } }), {
      name: 'callHealthEndpoint', description: 'health', requiresBrowser: false, tags: [],
    })
    registry.register('captureScreenshot', async () => ({ ok: true, output: { artifactId: 'shot-1' } }), {
      name: 'captureScreenshot', description: 'screenshot', requiresBrowser: true, tags: [],
    })
    registerFindingTools(registry)
    const provider: ModelProvider = { chat: vi.fn(async () => end) }
    const runtime = new AgentRuntime(provider, registry, createSessionServiceStub())
    runtime.registerAgent({ ...profile(false), toolPolicy: { browserAccess: false, allowedTools: ['callHealthEndpoint'] } })
    const apiStep = { ...STEP, id: 'health', capabilityId: 'callHealthEndpoint' }

    await runtime.executeStep('shopper', apiStep, { sessionId: 'api-session' })

    const offered = (vi.mocked(provider.chat).mock.calls[0]?.[1] ?? []).map((tool) => tool.name).sort()
    expect(offered).toEqual(['callHealthEndpoint', 'reportFinding'])
  })

  // Sixth pre-PR run, #1: a screenshot policy is satisfied by a screenshot, not by a DOM snippet.
  it('refuses a finding with only DOM snippet evidence when the policy requires a screenshot', async () => {
    const registry = new ToolRegistry()
    registry.register('submitOrder', async () => ({ ok: true, output: { orderSubmitted: true } }), {
      name: 'submitOrder', description: 'submit', requiresBrowser: false, tags: [],
    })
    registry.register('collectDomSnippet', async () => ({ ok: true, output: { artifactId: 'dom-1', selector: 'body', htmlLength: 10 } }), {
      name: 'collectDomSnippet', description: 'dom', requiresBrowser: false, tags: [],
    })
    registerFindingTools(registry)
    const sessionService = createSessionServiceStub()
    const session = sessionService.createSession('checkout_flow')
    const responses = [call('d', 'collectDomSnippet', { selector: 'body', description: 'cart' }), call('a', 'submitOrder'), call('c', 'reportFinding', finding(['dom-1'])), end]
    let index = 0
    const runtime = new AgentRuntime({ chat: vi.fn(async () => responses[index++] ?? end) }, registry, sessionService)
    runtime.registerAgent(profile(true))

    const result = await runtime.executeStep('shopper', STEP, { sessionId: session.id })

    expect(result.findings).toEqual([])
    expect(toolResults(sessionService, session.id, 'reportFinding')[0]).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'finding_without_evidence' }) }))
  })

  // Seventh pre-PR run, #1: a finding refused in the response that also completes the step never
  // reaches the model, because the step ends with that batch. Giving the model another round is the
  // deferred decision on a final reporting round (docs/p2-progresso.md); until then the loss is
  // recorded as an error event that names the finding, instead of only a tool_result.
  it('records an error event when the step ends with a finding the model never saw refused', async () => {
    const { runtime, provider, sessionService, sessionId } = setup([
      { text: '', toolCalls: [{ id: 'a', name: 'submitOrder', input: {} }, { id: 'c', name: 'reportFinding', input: finding() }], stopReason: 'tool_use' },
      end,
    ])
    const result = await runtime.executeStep('shopper', { ...STEP, producedArtifacts: ['orderSubmitted'] }, { sessionId })

    expect(result.status).toBe('completed')
    expect(vi.mocked(provider.chat).mock.calls).toHaveLength(1)
    expect(sessionService.getSession(sessionId)?.findings ?? []).toEqual([])
    const lost = (sessionService.getSession(sessionId)?.events ?? [])
      .filter((event) => event.type === 'error')
      .map((event) => (event.payload ?? event.data) as Record<string, unknown>)
      .filter((payload) => payload['event'] === 'finding_refused_at_step_end')
    expect(lost).toEqual([expect.objectContaining({
      stepId: 'checkout',
      toolCallId: 'c',
      title: 'Total ignores the discount',
      severity: 'high',
      code: 'finding_without_evidence',
    })])
  })

  it('records no lost-finding event when the model saw the refusal', async () => {
    const { runtime, sessionService, sessionId } = setup([call('c', 'reportFinding', finding()), call('a', 'submitOrder'), end])
    await runtime.executeStep('shopper', { ...STEP, producedArtifacts: ['orderSubmitted'] }, { sessionId })
    const events = sessionService.getSession(sessionId)?.events ?? []
    expect(events.some((event) => ((event.payload ?? event.data) as Record<string, unknown>)?.['event'] === 'finding_refused_at_step_end')).toBe(false)
  })

  // Seventh and eighth pre-PR runs, #3 / #1, #3, #4: captureScreenshot refuses a blank page, so on a
  // white screen the only evidence there can be is a DOM snippet. collectDomSnippet measures the page
  // with the same check and reports pageBlank; a screenshot policy accepts a snippet whose page was
  // blank when it was read. The order of calls does not matter, the page's state does. Uses the real
  // evidence handlers; `openHome` renders the page (and fails, so the step does not end).
  // `startUrl` is the page's URL until openHome runs; `pickEvidence` picks, from the artifactIds the
  // model was shown, the ones it reports (the last one by default).
  async function runOnBlankPage(
    firstCalls: ModelResponse[],
    { startUrl = 'http://127.0.0.1:8080/', pickEvidence = (ids: string[]) => ids.slice(-1) }: { startUrl?: string; pickEvidence?: (ids: string[]) => string[] } = {},
  ) {
    const registry = new ToolRegistry()
    const sessionService = createSessionServiceStub()
    let rendered = false
    registry.register('captureScreenshot', makeCaptureScreenshotHandler(sessionService), captureScreenshotMetadata)
    registry.register('collectDomSnippet', makeCollectDomSnippetHandler(sessionService), collectDomSnippetMetadata)
    registry.register('openHome', async () => {
      rendered = true
      return { ok: false, error: { code: 'control_missing', message: 'cart button not found', retryable: false } }
    }, { name: 'openHome', description: 'open home', requiresBrowser: false, tags: [] })
    registerFindingTools(registry)
    const session = sessionService.createSession('checkout_flow')
    // The DOM snippet id is generated, so the model reports the finding with the last artifactId it
    // was shown, as a model would.
    const chat = vi.fn(async (messages: Array<{ content: string }>): Promise<ModelResponse> => {
      const turn = chat.mock.calls.length - 1
      if (turn < firstCalls.length) return firstCalls[turn]!
      if (turn === firstCalls.length) {
        const ids = [...messages.map((message) => message.content).join('\n').matchAll(/"artifactId":"([^"]+)"/g)].map((match) => match[1]!)
        return call('c', 'reportFinding', { ...finding(pickEvidence(ids)), title: 'Home page renders a white screen' })
      }
      return end
    })
    const runtime = new AgentRuntime({ chat } as unknown as ModelProvider, registry, sessionService)
    runtime.registerAgent({ ...profile(true), toolPolicy: { browserAccess: true, allowedTools: ['openHome'] } })
    // Until openHome runs, the white screen of a broken SPA: no text and no visible element.
    const page = {
      url: () => (rendered ? 'http://127.0.0.1:8080/' : startUrl),
      evaluate: async () => rendered,
      screenshot: async () => Buffer.from('png'),
      locator: () => ({ innerHTML: async () => (rendered ? '<main>cart</main>' : '<div id="root"></div>') }),
    }
    const result = await runtime.executeStep('shopper', { ...STEP, id: 'home', capabilityId: 'openHome' }, { sessionId: session.id, page })
    return { result, sessionService, sessionId: session.id }
  }

  const recorded = (sessionService: SessionService, sessionId: string) => sessionService.getSession(sessionId)?.findings ?? []
  const refusedFinding = expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'finding_without_evidence' }) })

  it('accepts DOM evidence for a finding about a page captureScreenshot refused as blank', async () => {
    const { result, sessionService, sessionId } = await runOnBlankPage([
      call('s', 'captureScreenshot', { description: 'white screen' }),
      call('d', 'collectDomSnippet', { selector: 'body', description: 'empty root' }),
    ])

    expect(toolResults(sessionService, sessionId, 'captureScreenshot')[0]).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'blank_page' }) }))
    expect(toolResults(sessionService, sessionId, 'reportFinding')[0]).toEqual(expect.objectContaining({ ok: true }))
    const stored = recorded(sessionService, sessionId)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toEqual(expect.objectContaining({ title: 'Home page renders a white screen' }))
    expect(stored[0]?.evidence).toHaveLength(1)
    expect(result.findings).toEqual([expect.objectContaining({ title: 'Home page renders a white screen' })])
  })

  it('accepts a DOM snippet of the blank page taken before captureScreenshot refused it', async () => {
    const { result, sessionService, sessionId } = await runOnBlankPage([
      call('d', 'collectDomSnippet', { selector: 'body', description: 'empty root' }),
      call('s', 'captureScreenshot', { description: 'white screen' }),
    ])
    expect(toolResults(sessionService, sessionId, 'reportFinding')[0]).toEqual(expect.objectContaining({ ok: true }))
    expect(recorded(sessionService, sessionId)).toHaveLength(1)
    expect(result.findings).toHaveLength(1)
  })

  // A page is about:blank before the first navigation: a blank refusal there must not excuse
  // DOM-only evidence once the page has rendered.
  it('refuses a DOM snippet taken after the page rendered, even though captureScreenshot refused it earlier', async () => {
    const { result, sessionService, sessionId } = await runOnBlankPage([
      call('s', 'captureScreenshot', { description: 'before navigation' }),
      call('n', 'openHome'),
      call('d', 'collectDomSnippet', { selector: 'body', description: 'cart' }),
    ])
    expect(toolResults(sessionService, sessionId, 'captureScreenshot')[0]).toEqual(expect.objectContaining({ ok: false }))
    expect(toolResults(sessionService, sessionId, 'reportFinding')[0]).toEqual(refusedFinding)
    expect(recorded(sessionService, sessionId)).toEqual([])
    expect(result.findings).toEqual([])
  })

  it('refuses a DOM snippet of a rendered page when a screenshot was possible', async () => {
    const { result, sessionService, sessionId } = await runOnBlankPage([
      call('n', 'openHome'),
      call('s', 'captureScreenshot', { description: 'rendered page' }),
      call('d', 'collectDomSnippet', { selector: 'body', description: 'cart' }),
    ])
    expect(toolResults(sessionService, sessionId, 'captureScreenshot')[0]).toEqual(expect.objectContaining({ ok: true }))
    expect(toolResults(sessionService, sessionId, 'reportFinding')[0]).toEqual(refusedFinding)
    expect(recorded(sessionService, sessionId)).toEqual([])
    expect(result.findings).toEqual([])
  })

  // Tenth pre-PR run, #2: before the first navigation the page is about:blank, which is blank too. A
  // snippet of it says nothing about the application, so it does not stand in for a screenshot.
  it('refuses a DOM snippet of about:blank, taken before the page was opened', async () => {
    const { result, sessionService, sessionId } = await runOnBlankPage([
      call('d', 'collectDomSnippet', { selector: 'body', description: 'before navigation' }),
      call('n', 'openHome'),
      call('s', 'captureScreenshot', { description: 'rendered page' }),
    ], { startUrl: 'about:blank', pickEvidence: (ids) => ids.slice(0, 1) })
    const snippet = toolResults(sessionService, sessionId, 'collectDomSnippet')[0] as { ok?: boolean; output?: Record<string, unknown> }
    expect(snippet.output).toEqual(expect.objectContaining({ pageBlank: true, navigated: false }))
    expect(toolResults(sessionService, sessionId, 'reportFinding')[0]).toEqual(refusedFinding)
    expect(recorded(sessionService, sessionId)).toEqual([])
    expect(result.findings).toEqual([])
  })

  it('is registered by the runtime bootstrap', () => {
    const runtime = createPhase2Runtime({ deterministic: true, dbPath: ':memory:' } as never)
    expect(runtime.toolRegistry.has('reportFinding')).toBe(true)
  })
})
