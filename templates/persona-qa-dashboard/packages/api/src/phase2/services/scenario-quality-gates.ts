import { buildContractEvaluation } from './contract-evaluation.js'
import { filterSessionsForAvailableScenarios, getAvailableScenarioIds } from './available-scenarios.js'
import type { Session } from '../types/session-types.js'
import type { SessionService } from './session-service.js'
import { decideQualityGate, FINAL_SESSION_LIMIT, type GateDecision } from './quality-gate-decision.js'

export type { ScenarioQualityGateStatus } from './quality-gate-decision.js'

export interface ScenarioQualityGate extends GateDecision {
  scenarioId: string
  /** Last operator reset of this gate, if any. Sessions started before it are not counted. */
  resetAt?: string
}

function byRecent(a: Session, b: Session): number {
  return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
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

  // A-01: the thresholds live in quality-gate-decision.ts, shared with the control plane.
  const decision = decideQualityGate(finalSessions.map((session) => ({
    sessionStatus: session.status,
    verdict: buildContractEvaluation(session).contractEvaluation?.verdict ?? null,
  })))

  return {
    scenarioId,
    ...decision,
    reason: decision.status === 'restricted'
      ? `${decision.reason} Fix the cause, then reset the gate with POST /api/p2/scenarios/:scenarioId/quality-gate/reset to requalify it.`
      : decision.reason,
    ...(options.resetAt ? { resetAt: options.resetAt } : {}),
  }
}

/** The gate for one scenario, honouring its last operator reset. Every caller should use this. */
export function buildScenarioQualityGateForScenario(
  sessionService: SessionService,
  scenarioId: string,
  // The gate only looks at this scenario's sessions, so only those are loaded (B-09).
  sessions: Session[] = sessionService.getSessionsForScenario(scenarioId),
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
