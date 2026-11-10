/**
 * Conformance between the two contract evaluators (A-01 in docs/analise-20261109.md).
 * Run with: npx tsx packages/core/src/runtime/contract-conformance.test.ts
 *
 * The control plane judges executions with packages/core (buildAdapterContractEvaluation); the
 * installed runtime judges sessions with evaluateWorkflowContract (contract-verdict.ts in the
 * template). The runtime's is the source of truth and the core delegates to it, adapting its
 * sessions and models. This test runs both on the same sessions and requires the same verdict, so an
 * adaptation mistake in the core shows up here instead of in a user's verdict.
 */
import { evaluateWorkflowContract } from '../../../../templates/persona-qa-dashboard/packages/api/src/phase2/services/contract-evaluation.ts'
import { decideQualityGate } from '../../../../templates/persona-qa-dashboard/packages/api/src/phase2/services/quality-gate-decision.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runAdapterExecutionEngine } from './adapter-execution-engine.ts'
import { buildAdapterContractEvaluation } from './contract-evaluation.ts'
import { FileSessionStore } from './file-session-store.ts'
import { buildScenarioQualityGate } from './scenario-quality-gates.ts'

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

// --- Former divergences. The core now delegates to the runtime's verdict (A-01), so they agree. ---

// 1. An artifact the contract does not list (a screenshot, say) is informational, not drift. The core
//    used to call it drift; this is the case measured in the report.
const extraArtifact = judgeBoth(twoSteps, 'complete', [
  ['step_started', 'create'], ['tool_call', 'createOrder'], ['step_completed', 'create', ['orderId', 'screenshot_1']],
  ['step_started', 'pay'], ['tool_call', 'payOrder'], ['step_completed', 'pay'],
])
check(extraArtifact.core === 'contract_compliant' && extraArtifact.runtime === 'contract_compliant', `extra artifact: both compliant (core ${extraArtifact.core}, runtime ${extraArtifact.runtime})`)

// 2. A composite capability performed by its tools satisfies the step. The core used to require a
//    tool named exactly like the capability.
const compositeSteps: StepSpec[] = [{ id: 'close', capabilityId: 'validateManagementClosure' }]
const composite = judgeBoth(compositeSteps, 'complete', [
  ['step_started', 'close'], ['tool_call', 'verifyFinanceDashboard'], ['tool_call', 'verifyReportsPage'], ['step_completed', 'close'],
])
check(composite.core === 'contract_compliant' && composite.runtime === 'contract_compliant', `composite capability: both compliant (core ${composite.core}, runtime ${composite.runtime})`)

// 3. Same verdict object, not just the same label: the core result is the runtime result adapted.
const coreDetail = buildAdapterContractEvaluation(
  { status: 'complete', events: [], artifacts: {} } as never,
  { scenarioId: 'scenario' } as never,
  { scenarios: [{ id: 'scenario', steps: ['create'], stepDefinitions: [{ id: 'create', roleId: 'agent', capabilityId: 'createOrder', producesArtifacts: [] }], expectedArtifacts: [] }] } as never,
)
check(coreDetail?.verdict === 'contract_violated' && coreDetail.stepChecks[0]?.neverStarted === true && coreDetail.stepChecks[0]?.roleId === 'agent', `a step that never started is a violation in the core too (got ${coreDetail?.verdict})`)

// 4. A retry as the control-plane engine really records it, not as the runtime would. The sessions
//    above are written in the runtime's format; this one comes from runAdapterExecutionEngine, so a
//    difference in how the engine opens a retried step shows up here. Both evaluators read it.
const engineDir = await mkdtemp(path.join(tmpdir(), 'core-conformance-'))
try {
  const engineModel = {
    manifest: { id: 'm' }, auth: {}, routes: [], capabilities: [], personas: [],
    scenarios: [{
      id: 'scenario', title: 'scenario', roles: ['agent'], steps: ['create', 'pay'], expectedArtifacts: [],
      stepDefinitions: [
        { id: 'create', roleId: 'agent', capabilityId: 'createOrder', producesArtifacts: [] },
        { id: 'pay', roleId: 'agent', capabilityId: 'payOrder', producesArtifacts: [] },
      ],
    }],
  }
  for (const [label, reportOnRetry, expected] of [
    ['retry ran another capability', 'refundOrder', 'contract_drift'],
    ['retry ran the declared capability', 'createOrder', 'contract_compliant'],
  ] as const) {
    const store = new FileSessionStore({ dataPath: path.join(engineDir, `${expected}.json`) })
    await store.createSession({ id: 's', scenarioId: 'scenario', status: 'pending', startedAt: '', events: [], artifacts: {}, findings: [], checkpoint: { lastCompletedStep: -1, cursor: 0 } } as never)
    await runAdapterExecutionEngine({
      sessionStore: store,
      sessionId: 's',
      execution: { executionId: 'e', adapterId: 'm', scenarioId: 'scenario', hostProjectPath: '/x', status: 'initialized', personas: ['agent'], steps: ['create', 'pay'], notes: [] } as never,
      model: engineModel as never,
      stepDelayMs: 0,
      hooks: {
        executeStep: (ctx: { stepId: string; attempt: number }) => ctx.stepId === 'create' && ctx.attempt === 0
          ? { status: 'failed', retryable: true, maxRetries: 1, errorMessage: 'flaky', executedCapabilities: reportOnRetry === 'refundOrder' ? [] : ['refundOrder'] }
          : { executedCapabilities: [ctx.stepId === 'create' ? reportOnRetry : 'payOrder'] },
      } as never,
    })
    const session = await store.getSession('s')
    const core = buildAdapterContractEvaluation(session as never, { scenarioId: 'scenario' } as never, engineModel as never)
    const runtime = evaluateWorkflowContract(session as never, {
      steps: engineModel.scenarios[0].stepDefinitions.map((step, order) => ({ id: step.id, agentId: 'agent', capabilityId: step.capabilityId, order, producedArtifacts: [] })),
    } as never)
    check(core?.verdict === expected && runtime.verdict === expected, `engine session, ${label}: both ${expected} (core ${core?.verdict}, runtime ${runtime.verdict})`)
  }
} finally {
  await rm(engineDir, { recursive: true, force: true })
}

// --- Quality gate: same thresholds on both sides (A-01). ---
function gateBoth(outcomes: Array<['complete' | 'failed', string | null]>) {
  const now = Date.UTC(2026, 0, 1)
  const core = buildScenarioQualityGate('adapter', 'scenario', outcomes.map(([sessionStatus, verdict], index) => ({
    adapterId: 'adapter',
    scenarioId: 'scenario',
    sessionStatus,
    startedAt: new Date(now - index * 1000).toISOString(),
    contractEvaluation: verdict ? { verdict } as never : null,
  })))
  return { core: core.status, runtime: decideQualityGate(outcomes.map(([sessionStatus, verdict]) => ({ sessionStatus, verdict }))).status }
}
for (const [label, outcomes, expected] of [
  ['three violations', [['failed', 'contract_violated'], ['failed', 'contract_violated'], ['failed', 'contract_violated']], 'restricted'],
  ['one violation', [['failed', 'contract_violated'], ['complete', 'contract_compliant']], 'review_required'],
  ['two failures in a row', [['failed', 'contract_compliant'], ['failed', 'contract_compliant']], 'review_required'],
  ['three drifts', [['complete', 'contract_drift'], ['complete', 'contract_drift'], ['complete', 'contract_drift']], 'review_required'],
  ['clean', [['complete', 'contract_compliant'], ['complete', 'contract_compliant']], 'open'],
] as const) {
  const gate = gateBoth(outcomes.map(([status, verdict]) => [status, verdict]))
  check(gate.core === expected && gate.runtime === expected, `gate ${label}: both ${expected} (core ${gate.core}, runtime ${gate.runtime})`)
}

if (failed > 0) {
  console.error(`\n${failed} contract conformance check(s) failed`)
  process.exit(1)
}
console.log('\nContract conformance checks passed')
