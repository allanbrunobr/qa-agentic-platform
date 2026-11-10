import { describe, expect, it } from 'vitest'
import { AgentRuntime } from '../services/agent-runtime.js'
import { RuntimeHookBus } from '../services/runtime-hooks.js'
import { SessionService } from '../services/session-service.js'
import { ToolRegistry } from '../services/tool-registry.js'
import type { AgentProfile, ModelProvider, ModelResponse } from '../types/agent-types.js'

function makeProfile(): AgentProfile {
  return {
    role: 'test-agent',
    timeoutMs: 30_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    toolPolicy: { browserAccess: false },
    evidencePolicy: { requireScreenshotForFinding: false, requireDomSnippetForFinding: false },
    canBlockRun: false,
  }
}

describe('RuntimeHookBus', () => {
  it('emits runtime hooks around model execution and step completion', async () => {
    const hooks = new RuntimeHookBus()
    const events: string[] = []
    hooks.register('beforeModelCall', (event) => { events.push(event.name) })
    hooks.register('afterModelResponse', (event) => { events.push(event.name) })
    hooks.register('beforeStepComplete', (event) => { events.push(event.name) })
    hooks.register('afterStepComplete', (event) => { events.push(event.name) })

    const provider: ModelProvider = {
      async chat(): Promise<ModelResponse> {
        return {
          text: 'done',
          toolCalls: [],
          stopReason: 'end_turn',
        }
      },
    }
    const sessionService = new SessionService(':memory:')
    const session = sessionService.createSession('hook-test')
    const runtime = new AgentRuntime(provider, new ToolRegistry(), sessionService, hooks)

    const result = await runtime.executeStep(makeProfile(), {
      sessionId: session.id,
      messages: [{ role: 'user', content: 'complete without tools' }],
    })

    expect(result.status).toBe('completed')
    expect(events).toEqual([
      'beforeModelCall',
      'afterModelResponse',
      'beforeStepComplete',
      'afterStepComplete',
    ])
  })

  it('captures hook failures without breaking the caller', async () => {
    const hooks = new RuntimeHookBus()
    hooks.register('beforeModelCall', () => {
      throw new Error('hook failed')
    })

    const failures = await hooks.emit('beforeModelCall')

    expect(failures).toEqual([
      expect.objectContaining({ hookName: 'beforeModelCall', message: 'hook failed' }),
    ])
  })
})
