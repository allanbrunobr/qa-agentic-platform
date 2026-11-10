/**
 * Adapter execution engine (control-plane executions).
 * Run with: npx tsx packages/core/src/runtime/adapter-execution-engine.test.ts
 *
 * B-07: a hook that throws left the session "running" forever.
 * B-08: the retry loop was bounded by a hard-coded 1 while the give-up check used the step's
 * maxRetries, so a step that kept failing fell out of the loop and was recorded as completed.
 * Both in docs/analise-20261109.md.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runAdapterExecutionEngine } from './adapter-execution-engine.ts'
import { buildAdapterContractEvaluation } from './contract-evaluation.ts'
import { FileSessionStore } from './file-session-store.ts'

let failed = 0
function check(condition: unknown, message: string) {
  if (condition) console.log('PASS:', message)
  else {
    failed += 1
    console.error('FAIL:', message)
  }
}

const model = {
  manifest: { id: 'm', label: 'm', hostProduct: 'm', framework: 'x', status: 'draft' },
  auth: {}, routes: [], capabilities: [], personas: [],
  scenarios: [{
    id: 's1', title: 's1', roles: ['r'], steps: ['a', 'b'], expectedArtifacts: [],
    stepDefinitions: [
      { id: 'a', roleId: 'r', capabilityId: 'capA', producesArtifacts: [] },
      { id: 'b', roleId: 'r', capabilityId: 'capB', producesArtifacts: [] },
    ],
  }],
} as never

const dir = await mkdtemp(path.join(tmpdir(), 'core-engine-'))

async function run(label: string, hooks: Record<string, unknown>) {
  const store = new FileSessionStore({ dataPath: path.join(dir, `${label}.json`) })
  const sessionId = `sess-${label}`
  await store.createSession({
    id: sessionId, scenarioId: 's1', status: 'pending', startedAt: new Date().toISOString(),
    events: [], artifacts: {}, findings: [], checkpoint: { lastCompletedStep: -1, cursor: 0 },
  } as never)
  const execution = { executionId: 'e', adapterId: 'm', scenarioId: 's1', hostProjectPath: '/x', status: 'initialized', personas: ['r'], steps: ['a', 'b'], notes: [] } as never
  let thrown: string | null = null
  try {
    await runAdapterExecutionEngine({ sessionStore: store, sessionId, execution, model, hooks: hooks as never, stepDelayMs: 0 })
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }
  const session = await store.getSession(sessionId) as { status: string; events: Array<{ type: string; data?: Record<string, unknown> }> }
  return { session, thrown }
}

try {
  // B-07
  const throwing = await run('hook-throws', {
    executeStep: (ctx: { stepId: string }) => {
      if (ctx.stepId === 'b') throw new Error('boom from adapter')
      return {}
    },
  })
  check(throwing.thrown === 'boom from adapter', 'the hook error still reaches the caller')
  check(throwing.session.status === 'failed', `a session whose hook throws ends failed, not running (got ${throwing.session.status})`)
  check(throwing.session.events.some((event) => event.type === 'run_failed'), 'a thrown hook records run_failed')

  // B-08
  let attempts = 0
  const alwaysFailing = await run('always-fails', {
    executeStep: (ctx: { stepId: string }) => {
      if (ctx.stepId !== 'a') return {}
      attempts += 1
      return { status: 'failed', retryable: true, maxRetries: 3, errorMessage: 'always fails' }
    },
  })
  check(alwaysFailing.session.status === 'failed', `a step that never succeeds fails the session (got ${alwaysFailing.session.status})`)
  check(!alwaysFailing.session.events.some((event) => event.type === 'step_completed' && event.data?.['stepId'] === 'a'), 'a step that never succeeded is not recorded as completed')
  check(attempts === 4, `maxRetries 3 means four attempts (got ${attempts})`)

  let recoverAttempts = 0
  const recovering = await run('recovers', {
    executeStep: (ctx: { stepId: string; attempt: number }) => {
      if (ctx.stepId !== 'a') return {}
      recoverAttempts += 1
      return ctx.attempt < 2 ? { status: 'failed', retryable: true, maxRetries: 3, errorMessage: 'flaky' } : {}
    },
  })
  check(recovering.session.status === 'complete', `a step that recovers within its retries completes (got ${recovering.session.status})`)
  check(recoverAttempts === 3, `it stops retrying once it succeeds (got ${recoverAttempts} attempts)`)

  let defaultAttempts = 0
  await run('default-retries', {
    executeStep: (ctx: { stepId: string }) => {
      if (ctx.stepId !== 'a') return {}
      defaultAttempts += 1
      return { status: 'failed', retryable: true, errorMessage: 'flaky' }
    },
  })
  check(defaultAttempts === 2, `without maxRetries a retryable step gets one retry (got ${defaultAttempts} attempts)`)

  // B-11: the engine recorded the DECLARED capability as the tool used, so the contract's capability
  // check compared the declaration with itself and could never diverge.
  const toolsOf = (events: Array<{ type: string; data?: Record<string, unknown> }>, stepId: string) => events
    .filter((event) => event.type === 'tool_call' && event.data?.['stepId'] === stepId && typeof event.data?.['toolName'] === 'string')
    .map((event) => event.data?.['toolName'])

  const wrongCapability = await run('wrong-capability', {
    executeStep: (ctx: { stepId: string }) => ({ executedCapabilities: [ctx.stepId === 'b' ? 'refundOrder' : 'capA'] }),
  })
  const evaluation = buildAdapterContractEvaluation(wrongCapability.session as never, { scenarioId: 's1' } as never, model)
  check(JSON.stringify(toolsOf(wrongCapability.session.events, 'b')) === '["refundOrder"]', `the tool recorded for a step is the one the adapter reports (got ${JSON.stringify(toolsOf(wrongCapability.session.events, 'b'))})`)
  check(evaluation?.verdict === 'contract_drift', `a step that executed another capability is drift, not compliant (got ${evaluation?.verdict})`)
  check(evaluation?.stepChecks.find((step) => step.stepId === 'b')?.capabilityMismatch === true, 'the mismatched step is flagged')

  const unreported = await run('unreported-capability', { executeStep: () => ({}) })
  check(toolsOf(unreported.session.events, 'a').length === 0, 'when the adapter reports nothing, the engine does not invent the declared capability as the tool used')
  check(unreported.session.events.some((event) => event.type === 'tool_call' && event.data?.['declaredCapability'] === 'capA'), 'the dispatch still records which capability was declared')

  // A step retried after a failure: the verdict closes a step at step_failed and reopens it only at
  // step_started. The engine opened a step once, so what a retry reported fell outside every step and
  // a retry that ran another capability was judged compliant. Each attempt now opens the step, the
  // same format the runtime's orchestrator records.
  const retriedWrong = await run('retry-wrong-capability', {
    executeStep: (ctx: { stepId: string; attempt: number }) => ctx.stepId === 'a' && ctx.attempt === 0
      ? { status: 'failed', retryable: true, maxRetries: 2, errorMessage: 'flaky' }
      : { executedCapabilities: [ctx.stepId === 'a' ? 'refundOrder' : 'capB'] },
  })
  const retriedEvaluation = buildAdapterContractEvaluation(retriedWrong.session as never, { scenarioId: 's1' } as never, model)
  const retriedStepA = retriedEvaluation?.stepChecks.find((step) => step.stepId === 'a')
  check(JSON.stringify(retriedStepA?.observedTools) === '["refundOrder"]', `the capability a retry reports counts for its step (got ${JSON.stringify(retriedStepA?.observedTools)})`)
  check(retriedEvaluation?.verdict === 'contract_drift', `a retry that executed another capability is drift (got ${retriedEvaluation?.verdict})`)
  check(retriedWrong.session.events.filter((event) => event.type === 'step_started' && event.data?.['stepId'] === 'a').length === 2, 'each attempt of a step opens it with step_started')

  const retriedRight = await run('retry-right-capability', {
    executeStep: (ctx: { stepId: string; attempt: number }) => ctx.stepId === 'a' && ctx.attempt === 0
      ? { status: 'failed', retryable: true, maxRetries: 2, errorMessage: 'flaky', executedCapabilities: ['refundOrder'] }
      : { executedCapabilities: [ctx.stepId === 'a' ? 'capA' : 'capB'] },
  })
  const retriedRightEvaluation = buildAdapterContractEvaluation(retriedRight.session as never, { scenarioId: 's1' } as never, model)
  check(retriedRightEvaluation?.verdict === 'contract_compliant', `a retry that executed the declared capability is compliant (got ${retriedRightEvaluation?.verdict})`)
} finally {
  await rm(dir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} engine check(s) failed`)
  process.exit(1)
}
console.log('\nCore execution engine checks passed')
