import { dump } from 'js-yaml';
import { loadScenario } from '../scenarios/index.js';
import type { SessionService } from './session-service.js';
import { evaluateWorkflowContract } from './contract-verdict.js';

type Session = NonNullable<ReturnType<SessionService['getSession']>>;

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

  return {
    workflowContract,
    workflowContractYaml,
    contractEvaluation: evaluateWorkflowContract(session, workflowContract),
  };
}

export { evaluateWorkflowContract, summarizeStepOutcomes } from './contract-verdict.js';
