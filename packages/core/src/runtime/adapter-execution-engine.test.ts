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
} finally {
  await rm(dir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} engine check(s) failed`)
  process.exit(1)
}
console.log('\nCore execution engine checks passed')
