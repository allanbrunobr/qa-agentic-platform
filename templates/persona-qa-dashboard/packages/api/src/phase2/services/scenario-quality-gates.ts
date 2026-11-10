import { buildContractEvaluation } from './contract-evaluation.js'
import { filterSessionsForAvailableScenarios, getAvailableScenarioIds } from './available-scenarios.js'
import type { Session } from '../types/session-types.js'
import type { SessionService } from './session-service.js'

export type ScenarioQualityGateStatus = 'open' | 'review_required' | 'restricted'

export interface ScenarioQualityGate {
  scenarioId: string
  status: ScenarioQualityGateStatus
  reason: string
  recentFinalSessions: number
  recentViolated: number
  recentDrift: number
  consecutiveViolated: number
  consecutiveFailures: number
  /** Last operator reset of this gate, if any. Sessions started before it are not counted. */
  resetAt?: string
}

const FINAL_SESSION_LIMIT = 5

function byRecent(a: Session, b: Session): number {
  return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
}

function computeConsecutiveCount<T>(items: T[], predicate: (item: T) => boolean): number {
  let count = 0
  for (const item of items) {
    if (!predicate(item)) break
    count += 1
  }
  return count
}

export function buildScenarioQualityGateForSessions(
  scenarioId: string,
  sessions: Session[],
  options: { resetAt?: string } = {},
): ScenarioQualityGate {
  const resetTime = options.resetAt ? new Date(options.resetAt).getTime() : null
  const finalSessions = sessions
    .filter((session) => session.scenarioId === scenarioId)
    .filter((session) => session.status === 'complete' || session.status === 'failed')
    .filter((session) => resetTime === null || new Date(session.startedAt).getTime() > resetTime)
    .sort(byRecent)
    .slice(0, FINAL_SESSION_LIMIT)

  const evaluations = finalSessions.map((session) => ({
    session,
    evaluation: buildContractEvaluation(session).contractEvaluation,
  }))

  const recentViolated = evaluations.filter(({ evaluation }) => evaluation?.verdict === 'contract_violated').length
  const recentDrift = evaluations.filter(({ evaluation }) => evaluation?.verdict === 'contract_drift').length
  const consecutiveViolated = computeConsecutiveCount(
    evaluations,
    ({ evaluation }) => evaluation?.verdict === 'contract_violated',
  )
  const consecutiveFailures = computeConsecutiveCount(finalSessions, (session) => session.status === 'failed')

  if (recentViolated >= 3 || consecutiveViolated >= 3) {
    return {
      scenarioId,
      status: 'restricted',
      reason: 'Scenario automatically restricted after repeated contract violations in recent runs. '
        + 'Fix the cause, then reset the gate with POST /api/p2/scenarios/:scenarioId/quality-gate/reset to requalify it.',
      recentFinalSessions: finalSessions.length,
      recentViolated,
      recentDrift,
      consecutiveViolated,
      consecutiveFailures,
      ...(options.resetAt ? { resetAt: options.resetAt } : {}),
    }
  }

  if (recentViolated >= 1 || recentDrift >= 3 || consecutiveFailures >= 2) {
    return {
      scenarioId,
      status: 'review_required',
      reason: 'Scenario requires review due to recent violations, drift, or repeated failures.',
      recentFinalSessions: finalSessions.length,
      recentViolated,
      recentDrift,
      consecutiveViolated,
      consecutiveFailures,
      ...(options.resetAt ? { resetAt: options.resetAt } : {}),
    }
  }

  return {
    scenarioId,
    status: 'open',
    reason: 'Scenario is within current quality thresholds.',
    recentFinalSessions: finalSessions.length,
    recentViolated,
    recentDrift,
    consecutiveViolated,
    consecutiveFailures,
    ...(options.resetAt ? { resetAt: options.resetAt } : {}),
  }
}

/** The gate for one scenario, honouring its last operator reset. Every caller should use this. */
export function buildScenarioQualityGateForScenario(
  sessionService: SessionService,
  scenarioId: string,
  sessions: Session[] = sessionService.getAllSessions(),
): ScenarioQualityGate {
  const reset = sessionService.getLatestQualityGateReset(scenarioId)
  return buildScenarioQualityGateForSessions(scenarioId, sessions, reset ? { resetAt: reset.createdAt } : {})
}

export function buildScenarioQualityGateMap(sessionService: SessionService): Record<string, ScenarioQualityGate> {
  const sessions = filterSessionsForAvailableScenarios(sessionService.getAllSessions())
  const scenarioIds = getAvailableScenarioIds()
  return Object.fromEntries(
    scenarioIds.map((scenarioId) => [scenarioId, buildScenarioQualityGateForScenario(sessionService, scenarioId, sessions)]),
  )
}
