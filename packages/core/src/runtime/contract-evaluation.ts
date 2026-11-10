import type { AdapterExecutionDraft, AdapterModelBundle } from '../../../host-sdk/src/adapter-model.ts'
import type { Session } from '../contracts/session-types.ts'
// A-01: the verdict has one source of truth, the installed runtime's evaluator (6 production callers
// there against 1 here, and the one the e2e checks). This module adapts control-plane sessions and
// adapter models to it instead of keeping a second implementation.
import {
  evaluateWorkflowContract,
  summarizeStepOutcomes as summarizeVerdictStepOutcomes,
} from '../../../../templates/persona-qa-dashboard/packages/api/src/phase2/services/contract-verdict.ts'

export type ContractVerdict = 'contract_compliant' | 'contract_drift' | 'contract_violated' | 'contract_evaluating'

export interface StepContractCheck {
  stepId: string
  roleId: string
  expectedCapability: string
  observedTools: string[]
  expectedOrder: number
  observedOrder: number
  status: 'pending' | 'running' | 'complete' | 'failed'
  neverStarted: boolean
  incomplete: boolean
  outOfOrder: boolean
  capabilityMismatch: boolean
  expectedArtifacts: string[]
}

export interface AdapterContractEvaluation {
  verdict: ContractVerdict
  hardViolations: number
  driftSignals: number
  final: boolean
  expectedStepOrder: string[]
  observedStepOrder: string[]
  expectedArtifacts: string[]
  producedArtifacts: string[]
  missingArtifacts: string[]
  unexpectedArtifacts: string[]
  observedUnexpectedSteps: string[]
  /** Steps that failed at least once and then completed: retries that worked, not violations. */
  retriedSteps: string[]
  /** Produced artifacts the contract does not list: reported, not counted as drift. */
  informationalArtifacts: string[]
  stepChecks: StepContractCheck[]
}

function deriveProducedArtifacts(session: Session): string[] {
  const artifactNames = new Set<string>()

  for (const event of session.events ?? []) {
    const payload = (event.payload ?? event.data ?? {}) as Record<string, unknown>
    const produced = payload.producedArtifacts
    if (produced && typeof produced === 'object' && !Array.isArray(produced)) {
      for (const artifactId of Object.keys(produced as Record<string, unknown>)) {
        artifactNames.add(artifactId)
      }
    }
  }

  return Array.from(artifactNames)
}

export function buildAdapterContractEvaluation(
  session: Session,
  execution: AdapterExecutionDraft,
  model: AdapterModelBundle,
): AdapterContractEvaluation | null {
  const scenario = model.scenarios.find((item) => item.id === execution.scenarioId)
  if (!scenario) return null

  // The control-plane engine records produced artifacts on its step events, not in an artifact map.
  const producedArtifacts = deriveProducedArtifacts(session)
  const evaluation = evaluateWorkflowContract(
    {
      events: session.events ?? [],
      artifacts: Object.fromEntries(producedArtifacts.map((artifactId) => [artifactId, true])),
      status: session.status,
    },
    {
      steps: scenario.steps.map((stepId, index) => {
        const definition = scenario.stepDefinitions?.find((item) => item.id === stepId)
        return {
          id: stepId,
          agentId: definition?.roleId ?? 'unknown',
          capabilityId: definition?.capabilityId ?? 'unknown',
          order: index,
          producedArtifacts: definition?.producesArtifacts ?? [],
        }
      }),
    },
    { expectedArtifacts: scenario.expectedArtifacts },
  )

  return {
    ...evaluation,
    verdict: evaluation.verdict as ContractVerdict,
    stepChecks: evaluation.stepChecks.map(({ agentId, ...check }) => ({
      ...check,
      roleId: agentId,
      status: check.status as StepContractCheck['status'],
    })),
  }
}

/** Per-step outcome counting each step once (B-01), from the same implementation as the verdict. */
export function summarizeStepOutcomes(session: Session) {
  return summarizeVerdictStepOutcomes(session.events ?? [])
}
