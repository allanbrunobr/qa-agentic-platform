/**
 * Contract evaluation in packages/core (control-plane executions).
 * Run with: npx tsx packages/core/src/runtime/contract-evaluation.test.ts
 *
 * B-01 (docs/analise-20261109.md): a step that fails once and then completes on retry is complete;
 * only the last attempt decides, and a retry must not push the following steps out of order.
 */
import { buildAdapterContractEvaluation, summarizeStepOutcomes } from './contract-evaluation.ts'

let failed = 0
function check(condition: unknown, message: string) {
  if (condition) console.log('PASS:', message)
  else {
    failed += 1
    console.error('FAIL:', message)
  }
}

const model = {
  scenarios: [{
    id: 'order',
    steps: ['create', 'pay'],
    stepDefinitions: [
      { id: 'create', roleId: 'clerk', capabilityId: 'create', producesArtifacts: [] },
      { id: 'pay', roleId: 'clerk', capabilityId: 'pay', producesArtifacts: [] },
    ],
    expectedArtifacts: [],
  }],
} as never
const execution = { scenarioId: 'order' } as never

function session(status: 'complete' | 'failed', events: Array<[string, string]>) {
  return {
    status,
    events: events.map(([type, stepId], index) => ({
      id: String(index),
      type,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      data: type === 'tool_call' ? { toolName: stepId } : { stepId },
    })),
  } as never
}

const clean = buildAdapterContractEvaluation(session('complete', [
  ['step_started', 'create'], ['tool_call', 'create'], ['step_completed', 'create'],
  ['step_started', 'pay'], ['tool_call', 'pay'], ['step_completed', 'pay'],
]), execution, model)
check(clean?.verdict === 'contract_compliant', `clean run is compliant (got ${clean?.verdict})`)

const recovered = buildAdapterContractEvaluation(session('complete', [
  ['step_started', 'create'], ['tool_call', 'create'], ['step_failed', 'create'],
  ['step_started', 'create'], ['tool_call', 'create'], ['step_completed', 'create'],
  ['step_started', 'pay'], ['tool_call', 'pay'], ['step_completed', 'pay'],
]), execution, model)
check(recovered?.verdict === 'contract_compliant', `a step that recovered on retry is compliant (got ${recovered?.verdict})`)
check(recovered?.hardViolations === 0, 'a recovered retry adds no hard violation')
check(recovered?.stepChecks.every((step) => !step.outOfOrder) === true, 'a retry does not push later steps out of order')
check(JSON.stringify(recovered?.retriedSteps) === '["create"]', 'the recovered step is reported in retriedSteps')

const stillFailing = buildAdapterContractEvaluation(session('failed', [
  ['step_started', 'create'], ['tool_call', 'create'], ['step_failed', 'create'],
  ['step_started', 'create'], ['tool_call', 'create'], ['step_failed', 'create'],
]), execution, model)
check(stillFailing?.verdict === 'contract_violated', `a step whose last attempt failed is a violation (got ${stillFailing?.verdict})`)

const summary = summarizeStepOutcomes(session('complete', [
  ['step_started', 'a'], ['step_completed', 'a'], ['step_failed', 'a'],
]))
check(summary.lastOutcomeByStep.get('a') === 'failed', 'a failure after a completion is the last outcome')
check(summary.retriedSteps.length === 0, 'a step that ended failed is not reported as recovered')

if (failed > 0) {
  console.error(`\n${failed} contract evaluation check(s) failed`)
  process.exit(1)
}
console.log('\nCore contract evaluation checks passed')
