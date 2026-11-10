import type { AdapterExecutionDraft, AdapterModelBundle } from '../../../host-sdk/src/adapter-model.ts'
import type { Session } from '../contracts/session-types.ts'

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
  stepChecks: StepContractCheck[]
}

function deriveObservedToolsByStep(session: Session): Record<string, string[]> {
  const toolsByStep = new Map<string, string[]>()
  let activeStepId: string | null = null

  for (const event of session.events ?? []) {
    const payload = (event.payload ?? event.data ?? {}) as Record<string, unknown>

    if (event.type === 'step_started') {
      activeStepId = typeof payload.stepId === 'string' ? payload.stepId : null
      continue
    }

    if (event.type === 'tool_call' && activeStepId) {
      const toolName = typeof payload.toolName === 'string' ? payload.toolName : null
      if (!toolName) continue
      const current = toolsByStep.get(activeStepId) ?? []
      current.push(toolName)
      toolsByStep.set(activeStepId, current)
      continue
    }

    if (event.type === 'step_completed' || event.type === 'step_failed') {
      activeStepId = null
    }
  }

  return Object.fromEntries(Array.from(toolsByStep.entries()))
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

  const expectedStepOrder = scenario.steps
  const { observedStepOrder, lastOutcomeByStep, retriedSteps } = summarizeStepOutcomes(session)
  const startedStepIds = new Set(observedStepOrder)

  const observedToolsByStep = deriveObservedToolsByStep(session)
  const stepChecks: StepContractCheck[] = expectedStepOrder.map((stepId, index) => {
    const stepDefinition = scenario.stepDefinitions?.find((item) => item.id === stepId)
    const observedTools = observedToolsByStep[stepId] ?? []
    const observedIndex = observedStepOrder.indexOf(stepId)
    // The LAST attempt decides: a step that failed once and then completed on retry is complete.
    const lastOutcome = lastOutcomeByStep.get(stepId)
    const status =
      lastOutcome === 'failed'
        ? 'failed'
        : lastOutcome === 'complete'
          ? 'complete'
          : startedStepIds.has(stepId)
            ? 'running'
            : 'pending'

    return {
      stepId,
      roleId: stepDefinition?.roleId ?? 'unknown',
      expectedCapability: stepDefinition?.capabilityId ?? 'unknown',
      observedTools,
      expectedOrder: index,
      observedOrder: observedIndex,
      status,
      neverStarted: status === 'pending' && (session.status === 'complete' || session.status === 'failed'),
      incomplete: status === 'running' && session.status !== 'running' && session.status !== 'pending',
      outOfOrder: observedIndex !== -1 && observedIndex !== index,
      capabilityMismatch:
        observedTools.length > 0 && stepDefinition?.capabilityId
          ? !observedTools.includes(stepDefinition.capabilityId)
          : false,
      expectedArtifacts: stepDefinition?.producesArtifacts ?? [],
    }
  })

  const expectedArtifacts = scenario.expectedArtifacts
  const producedArtifacts = deriveProducedArtifacts(session)
  const isFinalSessionState = session.status === 'complete' || session.status === 'failed'
  const missingArtifacts = expectedArtifacts.filter((artifact) => !producedArtifacts.includes(artifact))
  const blockingMissingArtifacts = isFinalSessionState ? missingArtifacts : []
  const unexpectedArtifacts = producedArtifacts.filter((artifact) => !expectedArtifacts.includes(artifact))
  const observedUnexpectedSteps = observedStepOrder.filter((stepId) => !expectedStepOrder.includes(stepId))

  const hardViolations =
    stepChecks.filter((check) => check.neverStarted).length +
    stepChecks.filter((check) => check.incomplete).length +
    stepChecks.filter((check) => check.status === 'failed').length +
    blockingMissingArtifacts.length

  const driftSignals =
    unexpectedArtifacts.length +
    stepChecks.filter((check) => check.outOfOrder).length +
    observedUnexpectedSteps.length +
    stepChecks.filter((check) => check.capabilityMismatch).length

  const verdict: ContractVerdict =
    !isFinalSessionState
      ? 'contract_evaluating'
      : hardViolations > 0
        ? 'contract_violated'
        : driftSignals > 0
          ? 'contract_drift'
          : 'contract_compliant'

  return {
    verdict,
    hardViolations,
    driftSignals,
    final: isFinalSessionState,
    expectedStepOrder,
    observedStepOrder,
    expectedArtifacts,
    producedArtifacts,
    missingArtifacts,
    unexpectedArtifacts,
    observedUnexpectedSteps,
    retriedSteps,
    stepChecks,
  }
}

/**
 * Per-step outcome counting each step once (B-01): first step_started for the order, last
 * step_completed/step_failed for the status, and the steps that failed and then recovered.
 * Kept in step with the runtime template's summarizeStepOutcomes.
 */
export function summarizeStepOutcomes(session: Session) {
  const observedStepOrder: string[] = []
  const lastOutcomeByStep = new Map<string, 'complete' | 'failed'>()
  const failedOnce = new Set<string>()

  for (const event of session.events ?? []) {
    const stepId = String(((event.payload ?? event.data ?? {}) as Record<string, unknown>).stepId ?? '')
    if (!stepId) continue
    if (event.type === 'step_started' && !observedStepOrder.includes(stepId)) observedStepOrder.push(stepId)
    if (event.type === 'step_completed') lastOutcomeByStep.set(stepId, 'complete')
    if (event.type === 'step_failed') {
      lastOutcomeByStep.set(stepId, 'failed')
      failedOnce.add(stepId)
    }
  }

  const retriedSteps = Array.from(failedOnce).filter((stepId) => lastOutcomeByStep.get(stepId) === 'complete')
  return { observedStepOrder, lastOutcomeByStep, retriedSteps }
}
