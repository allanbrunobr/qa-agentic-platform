/**
 * The quality gate decision: one implementation for the installed runtime and the control plane
 * (A-01 in docs/analise-20261109.md). The runtime calls it from scenario-quality-gates.ts and
 * packages/core delegates to it. It depends on nothing, so the core can import it without the
 * runtime's dependencies.
 */

export type ScenarioQualityGateStatus = 'open' | 'review_required' | 'restricted'

/** How many of the most recent final sessions the gate looks at. */
export const FINAL_SESSION_LIMIT = 5

export interface GateOutcome {
  sessionStatus: string
  verdict?: string | null
}

export interface GateDecision {
  status: ScenarioQualityGateStatus
  reason: string
  recentFinalSessions: number
  recentViolated: number
  recentDrift: number
  consecutiveViolated: number
  consecutiveFailures: number
}

function computeConsecutiveCount<T>(items: T[], predicate: (item: T) => boolean): number {
  let count = 0
  for (const item of items) {
    if (!predicate(item)) break
    count += 1
  }
  return count
}

/** `outcomes` are the final sessions of one scenario, most recent first, at most FINAL_SESSION_LIMIT. */
export function decideQualityGate(outcomes: GateOutcome[]): GateDecision {
  const recentViolated = outcomes.filter((item) => item.verdict === 'contract_violated').length
  const recentDrift = outcomes.filter((item) => item.verdict === 'contract_drift').length
  const consecutiveViolated = computeConsecutiveCount(outcomes, (item) => item.verdict === 'contract_violated')
  const consecutiveFailures = computeConsecutiveCount(outcomes, (item) => item.sessionStatus === 'failed')
  const counts = {
    recentFinalSessions: outcomes.length,
    recentViolated,
    recentDrift,
    consecutiveViolated,
    consecutiveFailures,
  }

  if (recentViolated >= 3 || consecutiveViolated >= 3) {
    return { status: 'restricted', reason: 'Scenario automatically restricted after repeated contract violations in recent runs.', ...counts }
  }
  if (recentViolated >= 1 || recentDrift >= 3 || consecutiveFailures >= 2) {
    return { status: 'review_required', reason: 'Scenario requires review due to recent violations, drift, or repeated failures.', ...counts }
  }
  return { status: 'open', reason: 'Scenario is within current quality thresholds.', ...counts }
}
