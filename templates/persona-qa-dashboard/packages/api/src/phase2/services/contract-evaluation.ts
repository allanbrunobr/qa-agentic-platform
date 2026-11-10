import { dump } from 'js-yaml';
import { loadScenario } from '../scenarios/index.js';
import type { SessionService } from './session-service.js';

type Session = NonNullable<ReturnType<SessionService['getSession']>>;

function deriveObservedToolsByStep(session: Session): Record<string, string[]> {
  const toolsByStep = new Map<string, string[]>();
  let activeStepId: string | null = null;

  for (const event of session.events) {
    const payload = (event.payload ?? event.data ?? {}) as Record<string, unknown>;

    if (event.type === 'step_started') {
      activeStepId = typeof payload.stepId === 'string' ? payload.stepId : null;
      continue;
    }

    if (event.type === 'tool_call' && activeStepId) {
      const toolName = typeof payload.toolName === 'string' ? payload.toolName : null;
      if (!toolName) continue;
      const current = toolsByStep.get(activeStepId) ?? [];
      current.push(toolName);
      toolsByStep.set(activeStepId, current);
      continue;
    }

    if (event.type === 'step_completed' || event.type === 'step_failed') {
      activeStepId = null;
    }
  }

  return Object.fromEntries(Array.from(toolsByStep.entries()));
}

function capabilityMatchesObservedTools(capabilityId: string, observedTools: string[]): boolean {
  if (observedTools.includes(capabilityId)) return true;

  const compositeCapabilityMap: Record<string, string[]> = {
    validateManagementClosure: ['verifyFinanceDashboard', 'verifyReportsPage'],
  };

  const compositeTools = compositeCapabilityMap[capabilityId];
  if (!compositeTools) return false;

  return compositeTools.every((tool) => observedTools.includes(tool));
}

export function buildContractEvaluation(session: Session) {
  let scenario;
  try {
    scenario = loadScenario(session.scenarioId);
  } catch {
    return {
      workflowContract: null,
      workflowContractYaml: null,
      contractEvaluation: null,
    };
  }
  const workflowContract = scenario.workflowContract ?? null;
  const workflowContractYaml = workflowContract
    ? dump(workflowContract, { noRefs: true, lineWidth: 120, quotingType: "'" })
    : null;

  if (!workflowContract) {
    return {
      workflowContract,
      workflowContractYaml,
      contractEvaluation: null,
    };
  }

  const contractSteps = workflowContract.steps;
  const expectedStepOrder = contractSteps.map((step) => step.id);
  const { observedStepOrder, lastOutcomeByStep, retriedSteps } = summarizeStepOutcomes(session.events);
  const startedStepIds = new Set(observedStepOrder);
  const observedToolsByStep = deriveObservedToolsByStep(session);

  const stepChecks = contractSteps.map((step) => {
    const observedTools = observedToolsByStep[step.id] ?? [];
    const observedIndex = observedStepOrder.indexOf(step.id);
    // The LAST attempt decides: a step that failed once and then completed on retry is complete.
    const lastOutcome = lastOutcomeByStep.get(step.id);
    const status =
      lastOutcome === 'failed'
        ? 'failed'
        : lastOutcome === 'complete'
          ? 'complete'
          : startedStepIds.has(step.id)
            ? 'running'
            : 'pending';

    return {
      stepId: step.id,
      agentId: step.agentId,
      expectedCapability: step.capabilityId,
      observedTools,
      expectedOrder: step.order,
      observedOrder: observedIndex,
      status,
      neverStarted: status === 'pending' && (session.status === 'complete' || session.status === 'failed'),
      incomplete: status === 'running' && session.status !== 'running' && session.status !== 'pending',
      outOfOrder: observedIndex !== -1 && observedIndex !== step.order,
      capabilityMismatch:
        observedTools.length > 0 ? !capabilityMatchesObservedTools(step.capabilityId, observedTools) : false,
      expectedArtifacts: step.producedArtifacts,
    };
  });

  const expectedArtifacts = Array.from(new Set(contractSteps.flatMap((step) => step.producedArtifacts)));
  const producedArtifacts = Object.keys(session.artifacts ?? {});
  const isFinalSessionState = session.status === 'complete' || session.status === 'failed';
  const missingArtifacts = expectedArtifacts.filter((artifact) => !producedArtifacts.includes(artifact));
  const blockingMissingArtifacts = isFinalSessionState ? missingArtifacts : [];
  const unexpectedArtifacts = producedArtifacts.filter((artifact) => !expectedArtifacts.includes(artifact));
  const informationalArtifacts = unexpectedArtifacts;
  const observedUnexpectedSteps = observedStepOrder.filter((stepId) => !expectedStepOrder.includes(stepId));

  const hardViolations =
    stepChecks.filter((check) => check.neverStarted).length +
    stepChecks.filter((check) => check.incomplete).length +
    stepChecks.filter((check) => check.status === 'failed').length +
    blockingMissingArtifacts.length;

  const driftSignals =
    stepChecks.filter((check) => check.outOfOrder).length +
    observedUnexpectedSteps.length +
    stepChecks.filter((check) => check.capabilityMismatch).length;

  const verdict =
    !isFinalSessionState
      ? 'contract_evaluating'
      : hardViolations > 0
      ? 'contract_violated'
      : driftSignals > 0
        ? 'contract_drift'
        : 'contract_compliant';

  return {
    workflowContract,
    workflowContractYaml,
    contractEvaluation: {
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
      informationalArtifacts,
      observedUnexpectedSteps,
      retriedSteps,
      stepChecks,
    },
  };
}

/**
 * Per-step outcome from the session events, counting each step once (B-01 in
 * docs/analise-20261109.md):
 * - observedStepOrder keeps the FIRST step_started of each step, so a retry does not shift the
 *   steps after it out of order;
 * - lastOutcomeByStep keeps the LAST step_completed/step_failed of each step;
 * - retriedSteps lists steps that failed at least once and then completed. That is the retry policy
 *   working as designed: it is reported, not counted as a violation.
 */
export function summarizeStepOutcomes(events: Session['events']) {
  const observedStepOrder: string[] = [];
  const lastOutcomeByStep = new Map<string, 'complete' | 'failed'>();
  const failedOnce = new Set<string>();

  for (const event of events) {
    const stepId = String(((event.payload ?? event.data ?? {}) as Record<string, unknown>).stepId ?? '');
    if (!stepId) continue;
    if (event.type === 'step_started' && !observedStepOrder.includes(stepId)) observedStepOrder.push(stepId);
    if (event.type === 'step_completed') lastOutcomeByStep.set(stepId, 'complete');
    if (event.type === 'step_failed') {
      lastOutcomeByStep.set(stepId, 'failed');
      failedOnce.add(stepId);
    }
  }

  const retriedSteps = Array.from(failedOnce).filter((stepId) => lastOutcomeByStep.get(stepId) === 'complete');
  return { observedStepOrder, lastOutcomeByStep, retriedSteps };
}
