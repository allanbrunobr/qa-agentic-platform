import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Phase2SessionDetail, Phase2SessionEvent } from '@/lib/api'
import { SpecVsRunReal, summarizeStepOutcomes } from '../AgenticRuns'

// Eighth pre-PR run, #2 (docs/p2-progresso.md): the runtime records one step_started per attempt. The
// "Observed order" strip listed every attempt, so a step that recovered on retry pushed the steps after
// it out of place and showed them red while the verdict called the run compliant.

const event = (type: string, stepId: string, attempt?: number) => ({
  id: `${type}-${stepId}-${attempt ?? 0}`,
  sessionId: 's',
  type,
  timestamp: '2026-11-10T12:00:00.000Z',
  payload: { stepId, ...(attempt ? { attempt } : {}) },
}) as unknown as Phase2SessionEvent

const retriedRun = [
  event('step_started', 's1', 1), event('step_failed', 's1'),
  event('step_started', 's1', 2), event('step_completed', 's1'),
  event('step_started', 's2', 1), event('step_completed', 's2'),
]

const evaluation = {
  verdict: 'contract_compliant',
  hardViolations: 0,
  driftSignals: 0,
  final: true,
  expectedStepOrder: ['s1', 's2'],
  observedStepOrder: ['s1', 's2'],
  expectedArtifacts: [],
  producedArtifacts: [],
  missingArtifacts: [],
  unexpectedArtifacts: [],
  observedUnexpectedSteps: [],
  stepChecks: ['s1', 's2'].map((stepId, order) => ({
    stepId, agentId: 'agent', expectedCapability: stepId, observedTools: [], expectedOrder: order,
    observedOrder: order, status: 'complete', neverStarted: false, incomplete: false, outOfOrder: false,
    capabilityMismatch: false, expectedArtifacts: [],
  })),
} as NonNullable<Phase2SessionDetail['contractEvaluation']>

function observedLabels(contractEvaluation: Phase2SessionDetail['contractEvaluation']) {
  const sessionDetail = { id: 's', scenarioId: 'first-order', status: 'complete', artifacts: {}, contractEvaluation } as unknown as Phase2SessionDetail
  render(<SpecVsRunReal workflowContract={null} sessionDetail={sessionDetail} events={retriedRun} />)
  const strip = screen.getByText('Observed order').parentElement!
  return Array.from(strip.querySelectorAll('span')).map((span) => ({ text: span.textContent, red: span.className.includes('red') }))
}

describe('SpecVsRunReal observed order', () => {
  it('lists a retried step once, in its place, with the verdict', () => {
    expect(observedLabels(evaluation)).toEqual([{ text: '1. s1', red: false }, { text: '2. s2', red: false }])
  })

  it('counts a step once and by its last outcome without a verdict', () => {
    const outcomes = summarizeStepOutcomes(retriedRun)
    expect(outcomes.observedStepOrder).toEqual(['s1', 's2'])
    expect(outcomes.lastOutcomeByStep.get('s1')).toBe('complete')
  })
})
