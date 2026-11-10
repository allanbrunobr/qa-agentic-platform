import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../services/agent-runtime.js'
import { createSessionServiceStub } from '../services/session-service.js'
import { ToolRegistry } from '../services/tool-registry.js'
import { registerGeneratedAdapterTools } from '../tools/generated-adapter-tools.js'
import type { AgentProfile, ModelProvider, ModelResponse } from '../types/agent-types.js'
import type { ToolContext } from '../types/tool-types.js'

// B-02 (docs/analise-20261109.md): a run started with execution_context.targetBaseUrl (the dashboard's
// "target base URL" field) or targetRepoPath must test that target, even when the runtime was
// launched with PLAYWRIGHT_BASE_URL or AGENTIC_QA_TARGET_REPO pointing somewhere else.

const ENV_KEYS = ['PLAYWRIGHT_BASE_URL', 'AGENTIC_QA_TARGET_REPO', 'AGENTIC_QA_REPOSITORY_KIND'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const FRONTEND_POLICY = {
  browserAccess: true,
  allowedTools: ['openPrimaryRoute', 'fillCustomerEmail'],
}

function blankPage() {
  const visited: string[] = []
  let current = 'about:blank'
  return {
    visited,
    goto: async (url: string) => {
      visited.push(url)
      current = url
    },
    url: () => current,
    getByLabel: () => ({ first: () => ({ count: async () => 1, isVisible: async () => true, fill: async () => {} }) }),
    getByPlaceholder: () => ({ first: () => ({ count: async () => 1, isVisible: async () => true, fill: async () => {} }) }),
    locator: () => ({ first: () => ({ count: async () => 1, isVisible: async () => true, fill: async () => {} }) }),
  }
}

describe('generated frontend tools navigate to the run target', () => {
  it('uses the run base URL instead of PLAYWRIGHT_BASE_URL', async () => {
    process.env.PLAYWRIGHT_BASE_URL = 'http://env-target.local:3012'
    const registry = new ToolRegistry()
    registerGeneratedAdapterTools(registry)
    const page = blankPage()

    const result = await registry.execute('openPrimaryRoute', {}, FRONTEND_POLICY, {
      page,
      executionTarget: { baseUrl: 'http://requested-target.local:4000' },
    })

    expect(result.ok).toBe(true)
    expect(page.visited).toHaveLength(1)
    expect(page.visited[0]).toMatch(/^http:\/\/requested-target\.local:4000\//)
    expect(page.visited[0]).not.toContain('env-target.local')
  })

  it('uses the run base URL when another tool opens a blank page first', async () => {
    process.env.PLAYWRIGHT_BASE_URL = 'http://env-target.local:3012'
    const registry = new ToolRegistry()
    registerGeneratedAdapterTools(registry)
    const page = blankPage()

    await registry.execute('fillCustomerEmail', {}, FRONTEND_POLICY, {
      page,
      executionTarget: { baseUrl: 'http://requested-target.local:4000' },
    })

    expect(page.visited[0]).toMatch(/^http:\/\/requested-target\.local:4000\//)
  })

  it('keeps PLAYWRIGHT_BASE_URL as the fallback when the run has no target', async () => {
    process.env.PLAYWRIGHT_BASE_URL = 'http://env-target.local:3012'
    const registry = new ToolRegistry()
    registerGeneratedAdapterTools(registry)
    const page = blankPage()

    await registry.execute('openPrimaryRoute', {}, FRONTEND_POLICY, { page })

    expect(page.visited[0]).toMatch(/^http:\/\/env-target\.local:3012\//)
  })
})

describe('generated repository tools inspect the run target', () => {
  async function fixtureRepo(name: string, script: string) {
    const repo = await mkdtemp(path.join(tmpdir(), `execution-target-${name}-`))
    await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name, scripts: { test: script } }))
    return repo
  }

  it('uses the run targetRepoPath instead of AGENTIC_QA_TARGET_REPO', async () => {
    const envRepo = await fixtureRepo('env-repo', 'echo env')
    const requestedRepo = await fixtureRepo('requested-repo', 'echo requested')
    process.env.AGENTIC_QA_TARGET_REPO = envRepo
    process.env.AGENTIC_QA_REPOSITORY_KIND = 'unknown'
    const registry = new ToolRegistry()
    registerGeneratedAdapterTools(registry)

    const result = await registry.execute('identifyTestEntrypoints', {}, { browserAccess: false }, {
      executionTarget: { targetRepoPath: requestedRepo },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output).toEqual(expect.objectContaining({
        testEntrypoints: expect.objectContaining({ scripts: { test: 'echo requested' } }),
      }))
    }
  })
})

describe('agent runtime passes the run target to tools', () => {
  function profile(): AgentProfile {
    return {
      id: 'probe_agent',
      role: 'probe_agent',
      model: 'test-model',
      timeoutMs: 30000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      toolPolicy: { browserAccess: false, allowedTools: ['probeTarget'] },
      evidencePolicy: { requireScreenshotForFinding: false, requireDomSnippetForFinding: false },
      canBlockRun: false,
    }
  }

  it('delivers executionTarget in the tool context and keeps it out of the model prompt', async () => {
    const seen: ToolContext[] = []
    const registry = new ToolRegistry()
    registry.register('probeTarget', async (_input, context) => {
      seen.push(context)
      return { ok: true, output: { probe: { done: true } } }
    }, { name: 'probeTarget', description: 'probe', requiresBrowser: false, tags: [] })

    const responses: ModelResponse[] = [
      { text: '', toolCalls: [{ id: 'c1', name: 'probeTarget', input: {} }], stopReason: 'tool_use' },
      { text: 'done', toolCalls: [], stopReason: 'end_turn' },
    ]
    let index = 0
    const provider: ModelProvider = { chat: vi.fn(async () => responses[index++]!) }
    const runtime = new AgentRuntime(provider, registry, createSessionServiceStub())
    runtime.registerAgent(profile())

    const result = await runtime.executeStep('probe_agent', {
      id: 'probe_step',
      name: 'Probe',
      agentId: 'probe_agent',
      capabilityId: 'probeTarget',
      order: 0,
      requiredArtifacts: [],
      producedArtifacts: ['probe'],
    }, {
      sessionId: 'sess-target',
      executionTarget: { baseUrl: 'http://requested-target.local:4000', targetRepoPath: '/tmp/requested' },
    })

    expect(result.status).toBe('completed')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.executionTarget).toEqual({
      baseUrl: 'http://requested-target.local:4000',
      targetRepoPath: '/tmp/requested',
    })
    const firstPrompt = JSON.stringify(vi.mocked(provider.chat).mock.calls[0]?.[0])
    expect(firstPrompt).not.toContain('executionTarget')
  })
})
