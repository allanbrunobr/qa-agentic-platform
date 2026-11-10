import Fastify from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { phase2RunnerRoutes } from '../routes/runner.js'
import { setSessionService } from '../routes/sessions.js'
import { loadScenario } from '../scenarios/index.js'
import { SessionService } from '../services/session-service.js'
import { buildScenarioQualityGateForSessions } from '../services/scenario-quality-gates.js'

// B-01 (docs/analise-20261109.md): a restricted scenario rejects new runs, and without new runs its
// recent-session window never changes. The reset route is the audited way out.

const SCENARIO_ID = 'first_order'
const ENV_KEYS = ['PERSONA_QA_USE_REFERENCE_SCENARIOS', 'AGENTIC_QA_FORCE_DETERMINISTIC_RUNTIME'] as const
const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.PERSONA_QA_USE_REFERENCE_SCENARIOS = '1'
  // Skips provider validation, so POST /api/p2/runs reaches the quality gate check.
  process.env.AGENTIC_QA_FORCE_DETERMINISTIC_RUNTIME = '1'
})
afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function recordViolatedSession(service: SessionService) {
  const firstStep = loadScenario(SCENARIO_ID).workflowContract!.steps[0]!.id
  const session = service.createSession(SCENARIO_ID)
  service.addEvent(session.id, 'step_started', { stepId: firstStep })
  service.addEvent(session.id, 'step_failed', { stepId: firstStep, status: 'failed' })
  service.updateStatus(session.id, 'failed')
}

describe('quality gate reset route', () => {
  let service: SessionService
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    service = new SessionService(':memory:')
    setSessionService(service)
    app = Fastify()
    await app.register(phase2RunnerRoutes)
    for (let i = 0; i < 3; i += 1) recordViolatedSession(service)
    await sleep(5)
  })
  afterEach(async () => { await app.close() })

  async function gateStatus() {
    const response = await app.inject({ method: 'GET', url: '/api/p2/scenarios' })
    const scenario = (response.json() as Array<{ id: string; quality_gate: { status: string } }>).find((item) => item.id === SCENARIO_ID)
    return scenario?.quality_gate.status
  }

  it('three violations restrict the scenario and new runs get 409', async () => {
    expect(await gateStatus()).toBe('restricted')
    const run = await app.inject({ method: 'POST', url: '/api/p2/runs', payload: { scenario_id: SCENARIO_ID } })
    expect(run.statusCode).toBe(409)
    expect(run.json().quality_gate.reason).toContain('/quality-gate/reset')
  })

  it('a reset with a reason reopens the gate and is recorded with what it cleared', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/p2/scenarios/${SCENARIO_ID}/quality-gate/reset`,
      payload: { reason: 'Fixed the checkout selector after the redesign' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.previous_quality_gate.status).toBe('restricted')
    expect(body.quality_gate.status).toBe('open')
    expect(body.quality_gate.resetAt).toBe(body.reset.createdAt)
    expect(await gateStatus()).toBe('open')

    const stored = service.getLatestQualityGateReset(SCENARIO_ID)
    expect(stored).toEqual(expect.objectContaining({
      reason: 'Fixed the checkout selector after the redesign',
      previousStatus: 'restricted',
    }))
  })

  it('new violations after a reset restrict the scenario again', async () => {
    await app.inject({ method: 'POST', url: `/api/p2/scenarios/${SCENARIO_ID}/quality-gate/reset`, payload: { reason: 'Requalify after the fix' } })
    await sleep(5)
    for (let i = 0; i < 3; i += 1) recordViolatedSession(service)
    expect(await gateStatus()).toBe('restricted')
  })

  it('refuses a reset without a real reason', async () => {
    for (const payload of [{}, { reason: '' }, { reason: 'ok' }, { reason: 'x'.repeat(501) }]) {
      const response = await app.inject({ method: 'POST', url: `/api/p2/scenarios/${SCENARIO_ID}/quality-gate/reset`, payload })
      expect(response.statusCode).toBe(400)
    }
    expect(await gateStatus()).toBe('restricted')
    expect(service.getLatestQualityGateReset(SCENARIO_ID)).toBeNull()
  })

  it('refuses a reset for an unknown scenario', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/p2/scenarios/does_not_exist/quality-gate/reset',
      payload: { reason: 'Requalify after the fix' },
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('buildScenarioQualityGateForSessions with a reset', () => {
  it('ignores sessions that started before the reset', () => {
    const service = new SessionService(':memory:')
    for (let i = 0; i < 3; i += 1) recordViolatedSession(service)
    const sessions = service.getAllSessions()
    const latestStart = Math.max(...sessions.map((session) => new Date(session.startedAt).getTime()))
    expect(buildScenarioQualityGateForSessions(SCENARIO_ID, sessions).status).toBe('restricted')
    expect(buildScenarioQualityGateForSessions(SCENARIO_ID, sessions, { resetAt: new Date(latestStart + 1).toISOString() }).status).toBe('open')
  })
})
