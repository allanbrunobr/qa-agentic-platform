import type { AdapterContractEvaluation } from './contract-evaluation.ts'
// A-01: one implementation of the gate decision, shared with the installed runtime.
import {
  decideQualityGate,
  FINAL_SESSION_LIMIT,
} from '../../../../templates/persona-qa-dashboard/packages/api/src/phase2/services/quality-gate-decision.ts'

export type ScenarioQualityGateStatus = 'open' | 'review_required' | 'restricted'

export interface ScenarioQualityGate {
  adapterId: string
  scenarioId: string
  status: ScenarioQualityGateStatus
  reason: string
  recentFinalSessions: number
  recentViolated: number
  recentDrift: number
  consecutiveViolated: number
  consecutiveFailures: number
}

export interface ScenarioEvaluationInput {
  adapterId: string
  scenarioId: string
  sessionStatus: 'pending' | 'running' | 'complete' | 'failed'
  startedAt: string
  contractEvaluation: AdapterContractEvaluation | null
}

export function buildScenarioQualityGate(
  adapterId: string,
  scenarioId: string,
  evaluations: ScenarioEvaluationInput[],
): ScenarioQualityGate {
  const finalEvaluations = evaluations
    .filter((item) => item.adapterId === adapterId && item.scenarioId === scenarioId)
    .filter((item) => item.sessionStatus === 'complete' || item.sessionStatus === 'failed')
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, FINAL_SESSION_LIMIT)

  return {
    adapterId,
    scenarioId,
    ...decideQualityGate(finalEvaluations.map((item) => ({
      sessionStatus: item.sessionStatus,
      verdict: item.contractEvaluation?.verdict ?? null,
    }))),
  }
}
