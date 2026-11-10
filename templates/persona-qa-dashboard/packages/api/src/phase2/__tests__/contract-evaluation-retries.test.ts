import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadScenario } from '../scenarios/index.js'
import { buildContractEvaluation, summarizeStepOutcomes } from '../services/contract-evaluation.js'
import { buildScenarioQualityGateForSessions } from '../services/scenario-quality-gates.js'

// B-01 (docs/analise-20261109.md): a step that fails once and then completes on retry is the retry
// policy working as designed. It must not turn a complete session into contract_violated, and three
// such sessions must not lock the scenario as restricted. Events follow the shape the orchestrator
// writes: step_failed (recoverable_failed) for the attempt, then a new step_started.

const SCENARIO_ID = 'first_order_multi_role'
let previousFlag: string | undefined

beforeAll(() => {
  previousFlag = process.env.PERSONA_QA_USE_REFERENCE_SCENARIOS
  process.env.PERSONA_QA_USE_REFERENCE_SCENARIOS = '1'
})
afterAll(() => {
  if (previousFlag === undefined) delete process.env.PERSONA_QA_USE_REFERENCE_SCENARIOS
  else process.env.PERSONA_QA_USE_REFERENCE_SCENARIOS = previousFlag
})

type Mode = 'clean' | 'retry_recovered' | 'retry_still_failing'

function session(index: number, mode: Mode) {
  const steps = loadScenario(SCENARIO_ID).workflowContract!.steps
  const events: Array<Record<string, unknown>> = []
  let seq = 0
  const add = (type: string, payload: Record<string, unknown>) => {
    seq += 1
    events.push({
      id: `${index}-${seq}`,
      sessionId: `s${index}`,
      type,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, index, seq)).toISOString(),
      payload,
      data: payload,
    })
  }

  let status: 'complete' | 'failed' = 'complete'
  steps.forEach((step, stepIndex) => {
    if (stepIndex === 0 && mode !== 'clean') {
      add('step_started', { stepId: step.id, attempt: 1 })
      add('tool_call', { toolName: step.capabilityId })
      add('step_failed', { stepId: step.id, attempt: 1, status: 'recoverable_failed' })
    }
    if (stepIndex === 0 && mode === 'retry_still_failing') {
      add('step_started', { stepId: step.id, attempt: 2 })
      add('tool_call', { toolName: step.capabilityId })
      add('step_failed', { stepId: step.id, attempt: 2, status: 'failed' })
      status = 'failed'
      return
    }
    if (status === 'failed') return
    add('step_started', { stepId: step.id, attempt: stepIndex === 0 && mode !== 'clean' ? 2 : 1 })
    add('tool_call', { toolName: step.capabilityId })
    add('step_completed', { stepId: step.id })
  })

  const artifacts = status === 'complete'
    ? Object.fromEntries(steps.flatMap((step) => step.producedArtifacts).map((artifact) => [artifact, { value: 1 }]))
    : {}
  return {
    id: `s${index}`,
    scenarioId: SCENARIO_ID,
    status,
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    events,
    artifacts,
    findings: [],
    checkpoint: { lastCompletedStep: steps.length - 1, cursor: 0 },
  } as unknown as Parameters<typeof buildContractEvaluation>[0]
}

describe('contract evaluation with retries', () => {
  it('a clean run is compliant', () => {
    expect(buildContractEvaluation(session(0, 'clean')).contractEvaluation?.verdict).toBe('contract_compliant')
  })

  it('a step that recovered on retry is complete, in order, and reported as retried', () => {
    const evaluation = buildContractEvaluation(session(1, 'retry_recovered')).contractEvaluation!
    const firstStep = loadScenario(SCENARIO_ID).workflowContract!.steps[0]!.id
    expect(evaluation.verdict).toBe('contract_compliant')
    expect(evaluation.hardViolations).toBe(0)
    expect(evaluation.driftSignals).toBe(0)
    expect(evaluation.stepChecks.every((check) => check.status === 'complete')).toBe(true)
    expect(evaluation.stepChecks.filter((check) => check.outOfOrder)).toEqual([])
    expect(evaluation.retriedSteps).toEqual([firstStep])
  })

  it('a step whose last attempt failed is still a violation', () => {
    const evaluation = buildContractEvaluation(session(2, 'retry_still_failing')).contractEvaluation!
    expect(evaluation.verdict).toBe('contract_violated')
    expect(evaluation.stepChecks[0]!.status).toBe('failed')
    expect(evaluation.retriedSteps).toEqual([])
  })

  it('three runs that recovered on retry do not restrict the scenario', () => {
    const gate = buildScenarioQualityGateForSessions(SCENARIO_ID, [3, 4, 5].map((n) => session(n, 'retry_recovered')))
    expect(gate.status).toBe('open')
  })

  it('three runs that kept failing still restrict the scenario', () => {
    const gate = buildScenarioQualityGateForSessions(SCENARIO_ID, [6, 7, 8].map((n) => session(n, 'retry_still_failing')))
    expect(gate.status).toBe('restricted')
  })
})

describe('summarizeStepOutcomes', () => {
  const event = (type: string, stepId: string) => ({ type, payload: { stepId } }) as never

  it('keeps first starts, last outcomes, and lists recovered steps', () => {
    const summary = summarizeStepOutcomes([
      event('step_started', 'a'), event('step_failed', 'a'),
      event('step_started', 'a'), event('step_completed', 'a'),
      event('step_started', 'b'), event('step_completed', 'b'),
      event('step_started', 'c'), event('step_completed', 'c'), event('step_failed', 'c'),
    ])
    expect(summary.observedStepOrder).toEqual(['a', 'b', 'c'])
    expect(summary.lastOutcomeByStep.get('a')).toBe('complete')
    expect(summary.lastOutcomeByStep.get('c')).toBe('failed')
    expect(summary.retriedSteps).toEqual(['a'])
  })
})
