import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../services/agent-runtime.js'
import { createSessionServiceStub } from '../services/session-service.js'
import { ToolRegistry } from '../services/tool-registry.js'
import type { AgentProfile, ModelMessage, ModelProvider, ModelResponse } from '../types/agent-types.js'

// B-10 (docs/analise-20261109.md), two runtime items:
// - a contract step's timeoutMs never became the step deadline, so the orchestrator's "increase
//   timeout" adaptation was recorded as applied and had no effect;
// - the early completion on a produced artifact returned in the middle of a tool batch, skipping the
//   calls after it, verifications included.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function profile(timeoutMs: number): AgentProfile {
  return {
    id: 'operator',
    role: 'operator',
    model: 'test-model',
    timeoutMs,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    toolPolicy: { browserAccess: false },
    evidencePolicy: { requireScreenshotForFinding: false, requireDomSnippetForFinding: false },
    canBlockRun: false,
  }
}

function scripted(responses: ModelResponse[]): ModelProvider {
  let index = 0
  return {
    chat: vi.fn(async (_messages: ModelMessage[]): Promise<ModelResponse> =>
      responses[index++] ?? { text: 'done', toolCalls: [], stopReason: 'end_turn' }),
  }
}

describe('step timeout from the contract', () => {
  it('uses the step timeoutMs as the deadline instead of the profile default', async () => {
    const registry = new ToolRegistry()
    registry.register('slowCapability', async () => {
      await sleep(400)
      return { ok: true, output: { slowDone: true } }
    }, { name: 'slowCapability', description: 'slow', requiresBrowser: false, tags: [] })
    const runtime = new AgentRuntime(scripted([
      { text: '', toolCalls: [{ id: 't1', name: 'slowCapability', input: {} }], stopReason: 'tool_use' },
    ]), registry, createSessionServiceStub())
    runtime.registerAgent(profile(5_000))

    const result = await runtime.executeStep('operator', {
      id: 'slow_step', name: 'slow step', agentId: 'operator', capabilityId: 'slowCapability', order: 0,
      requiredArtifacts: [], producedArtifacts: [], timeoutMs: 100,
    }, { sessionId: 'timeout-session' })

    expect(result.status).toBe('timeout')
  })
})

describe('early completion inside a tool batch', () => {
  it('runs every tool call of the batch before completing on a produced artifact', async () => {
    const executed: string[] = []
    const registry = new ToolRegistry()
    registry.register('verifyFinanceDashboard', async () => {
      executed.push('verifyFinanceDashboard')
      return { ok: true, output: { financeValidated: true } }
    }, { name: 'verifyFinanceDashboard', description: 'finance', requiresBrowser: false, tags: [] })
    registry.register('verifyReportsPage', async () => {
      executed.push('verifyReportsPage')
      return { ok: true, output: { reportsChecked: true } }
    }, { name: 'verifyReportsPage', description: 'reports', requiresBrowser: false, tags: [] })
    const runtime = new AgentRuntime(scripted([
      {
        text: '',
        toolCalls: [
          { id: 'a', name: 'verifyFinanceDashboard', input: {} },
          { id: 'b', name: 'verifyReportsPage', input: {} },
        ],
        stopReason: 'tool_use',
      },
    ]), registry, createSessionServiceStub())
    runtime.registerAgent(profile(5_000))

    const result = await runtime.executeStep('operator', {
      id: 'close_month', name: 'close month', agentId: 'operator', capabilityId: 'validateManagementClosure', order: 0,
      requiredArtifacts: [], producedArtifacts: ['financeValidated'],
    }, { sessionId: 'batch-session' })

    expect(result.status).toBe('completed')
    expect(executed).toEqual(['verifyFinanceDashboard', 'verifyReportsPage'])
    expect(result.output).toMatchObject({ financeValidated: true, reportsChecked: true })
  })
})
