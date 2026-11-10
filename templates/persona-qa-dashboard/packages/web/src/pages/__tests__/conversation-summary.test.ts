import { describe, expect, it } from 'vitest'
import type { Phase2SessionEvent } from '@/lib/api'
import { summarizeConversationEvent } from '../AgenticRuns'

// Seventh pre-PR run, #1 (docs/p2-progresso.md): a finding refused in the response that ended its step
// is recorded as an error event. The agent conversation panel showed only tool calls, tool results,
// handoffs and step events, so that event was invisible in the dashboard.
describe('summarizeConversationEvent', () => {
  it('shows a finding the runtime refused at the end of its step', () => {
    const event = {
      id: 'e1',
      sessionId: 's1',
      type: 'error',
      timestamp: '2026-11-10T12:00:00.000Z',
      agentRole: 'shopper',
      payload: {
        event: 'finding_refused_at_step_end',
        stepId: 'checkout',
        toolCallId: 'c',
        title: 'Total ignores the discount',
        severity: 'high',
        code: 'finding_without_evidence',
      },
    } as unknown as Phase2SessionEvent

    const summary = summarizeConversationEvent(event)

    expect(summary?.title).toBe('Finding not recorded: Total ignores the discount')
    expect(summary?.body).toContain('finding_without_evidence')
  })

  it('still leaves other error events out of the conversation', () => {
    const event = { id: 'e2', sessionId: 's1', type: 'error', timestamp: '', agentRole: 'shopper', payload: { error: 'x' } } as unknown as Phase2SessionEvent
    expect(summarizeConversationEvent(event)).toBeNull()
  })
})
