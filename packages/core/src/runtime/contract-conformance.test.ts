/**
 * Conformance between the two contract evaluators (A-01 in docs/analise-20261109.md).
 * Run with: npx tsx packages/core/src/runtime/contract-conformance.test.ts
 *
 * The control plane judges executions with packages/core (buildAdapterContractEvaluation); the
 * installed runtime judges sessions with its own copy (evaluateWorkflowContract in the template).
 * Choosing one source of truth is still open. Until then this test runs both on the same sessions:
 * where they must agree it says so, and where they are known to differ it pins the current
 * difference, so a change on either side shows up here instead of in a user's verdict.
 */
import { evaluateWorkflowContract } from '../../../../templates/persona-qa-dashboard/packages/api/src/phase2/services/contract-evaluation.ts'
import { buildAdapterContractEvaluation } from './contract-evaluation.ts'

let failed = 0
function check(condition: unknown, message: string) {
  if (condition) console.log('PASS:', message)
  else {
    failed += 1
    console.error('FAIL:', message)
  }
}

interface StepSpec {
  id: string
  capabilityId: string
  produces?: string[]
}

type Event = [type: string, stepOrTool: string, produced?: string[]]

/** One scenario, described once and handed to each evaluator in the shape it reads. */
function judgeBoth(steps: StepSpec[], status: 'complete' | 'failed', events: Event[]) {
  const sessionEvents = events.map(([type, value, produced], index) => ({
    id: String(index),
    sessionId: 's',
    type,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    payload: type === 'tool_call'
      ? { toolName: value }
      : { stepId: value, ...(produced ? { producedArtifacts: Object.fromEntries(produced.map((name) => [name, true])) } : {}) },
  }))
  // The core reads produced artifacts from the step events; the runtime reads the session's artifact map.
  const artifacts = Object.fromEntries(events.flatMap(([, , produced]) => produced ?? []).map((name) => [name, true]))
  const session = { id: 's', scenarioId: 'scenario', status, startedAt: '', events: sessionEvents, artifacts, findings: [] }

  const core = buildAdapterContractEvaluation(
    session as never,
    { scenarioId: 'scenario' } as never,
    {
      scenarios: [{
        id: 'scenario',
        steps: steps.map((step) => step.id),
        stepDefinitions: steps.map((step) => ({ id: step.id, roleId: 'agent', capabilityId: step.capabilityId, producesArtifacts: step.produces ?? [] })),
        expectedArtifacts: steps.flatMap((step) => step.produces ?? []),
      }],
    } as never,
  )
  const runtime = evaluateWorkflowContract(session as never, {
    steps: steps.map((step, order) => ({
      id: step.id,
      name: step.id,
      agentId: 'agent',
      capabilityId: step.capabilityId,
      order,
      requiredArtifacts: [],
      producedArtifacts: step.produces ?? [],
    })),
  } as never)
  return { core: core?.verdict, runtime: runtime.verdict }
}

const twoSteps: StepSpec[] = [
  { id: 'create', capabilityId: 'createOrder', produces: ['orderId'] },
  { id: 'pay', capabilityId: 'payOrder' },
]
const cleanEvents: Event[] = [
  ['step_started', 'create'], ['tool_call', 'createOrder'], ['step_completed', 'create', ['orderId']],
  ['step_started', 'pay'], ['tool_call', 'payOrder'], ['step_completed', 'pay'],
]

// --- Where both must agree ---

const clean = judgeBoth(twoSteps, 'complete', cleanEvents)
check(clean.core === 'contract_compliant' && clean.runtime === 'contract_compliant', `clean run: both compliant (core ${clean.core}, runtime ${clean.runtime})`)

const recovered = judgeBoth(twoSteps, 'complete', [
  ['step_started', 'create'], ['tool_call', 'createOrder'], ['step_failed', 'create'],
  ...cleanEvents,
])
check(recovered.core === 'contract_compliant' && recovered.runtime === 'contract_compliant', `step recovered on retry: both compliant (core ${recovered.core}, runtime ${recovered.runtime})`)

const lastAttemptFailed = judgeBoth(twoSteps, 'failed', [
  ['step_started', 'create'], ['tool_call', 'createOrder'], ['step_failed', 'create'],
])
check(lastAttemptFailed.core === 'contract_violated' && lastAttemptFailed.runtime === 'contract_violated', `last attempt failed: both violated (core ${lastAttemptFailed.core}, runtime ${lastAttemptFailed.runtime})`)

const missingArtifact = judgeBoth(twoSteps, 'complete', [
  ['step_started', 'create'], ['tool_call', 'createOrder'], ['step_completed', 'create'],
  ['step_started', 'pay'], ['tool_call', 'payOrder'], ['step_completed', 'pay'],
])
check(missingArtifact.core === 'contract_violated' && missingArtifact.runtime === 'contract_violated', `expected artifact missing: both violated (core ${missingArtifact.core}, runtime ${missingArtifact.runtime})`)

const wrongTool = judgeBoth(twoSteps, 'complete', [
  ['step_started', 'create'], ['tool_call', 'createOrder'], ['step_completed', 'create', ['orderId']],
  ['step_started', 'pay'], ['tool_call', 'refundOrder'], ['step_completed', 'pay'],
])
check(wrongTool.core === 'contract_drift' && wrongTool.runtime === 'contract_drift', `step used a different tool: both drift (core ${wrongTool.core}, runtime ${wrongTool.runtime})`)

// --- Known divergences, pinned. If one of these changes, decide which evaluator is right. ---

// 1. An artifact the contract does not list (a screenshot, say): drift for the core, informational
//    for the runtime. This is the case measured in the report.
const extraArtifact = judgeBoth(twoSteps, 'complete', [
  ['step_started', 'create'], ['tool_call', 'createOrder'], ['step_completed', 'create', ['orderId', 'screenshot_1']],
  ['step_started', 'pay'], ['tool_call', 'payOrder'], ['step_completed', 'pay'],
])
check(extraArtifact.core === 'contract_drift' && extraArtifact.runtime === 'contract_compliant', `KNOWN DIVERGENCE extra artifact: core drift, runtime compliant (core ${extraArtifact.core}, runtime ${extraArtifact.runtime})`)

// 2. A composite capability performed by its tools: the runtime accepts it, the core only accepts a
//    tool named exactly like the capability.
const compositeSteps: StepSpec[] = [{ id: 'close', capabilityId: 'validateManagementClosure' }]
const composite = judgeBoth(compositeSteps, 'complete', [
  ['step_started', 'close'], ['tool_call', 'verifyFinanceDashboard'], ['tool_call', 'verifyReportsPage'], ['step_completed', 'close'],
])
check(composite.core === 'contract_drift' && composite.runtime === 'contract_compliant', `KNOWN DIVERGENCE composite capability: core drift, runtime compliant (core ${composite.core}, runtime ${composite.runtime})`)

if (failed > 0) {
  console.error(`\n${failed} contract conformance check(s) failed`)
  process.exit(1)
}
console.log('\nContract conformance checks passed')
