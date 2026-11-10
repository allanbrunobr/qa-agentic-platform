import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionService } from '../services/session-service.js'
import { buildScenarioQualityGateForScenario, buildScenarioQualityGateForSessions } from '../services/scenario-quality-gates.js'

// B-09 (docs/analise-20261109.md): addEvent reloaded the whole session (every event, artifact and
// finding) on each call; the quality gate on every run loaded every session of every scenario; and
// one row with invalid JSON made all of those reads throw, so the runner and the stats answered 500.

const dirs: string[] = []
function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentic-session-load-'))
  dirs.push(dir)
  return path.join(dir, 'sessions.db')
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SessionService load', () => {
  it('addEvent does not reload the session it appends to', () => {
    const service = new SessionService(':memory:')
    const session = service.createSession('checkout')
    const getSession = vi.spyOn(service, 'getSession')

    service.addEvent(session.id, 'info', { message: 'hello' })
    service.addEvent('not-created-yet', 'info', { message: 'stub session' })

    expect(getSession).not.toHaveBeenCalled()
    expect(service.getSession('not-created-yet')?.events).toHaveLength(1)
  })

  it('the quality gate for one scenario reads only that scenario and gives the same result', () => {
    const service = new SessionService(':memory:')
    for (const scenarioId of ['checkout', 'checkout', 'refund', 'refund', 'refund']) {
      const session = service.createSession(scenarioId)
      service.addEvent(session.id, 'step_started', { stepId: 'a' })
      service.updateStatus(session.id, 'complete')
    }
    const everything = service.getAllSessions()
    const getAllSessions = vi.spyOn(service, 'getAllSessions')

    const gate = buildScenarioQualityGateForScenario(service, 'checkout')

    expect(getAllSessions).not.toHaveBeenCalled()
    expect(gate).toEqual(buildScenarioQualityGateForSessions('checkout', everything))
  })

  it('a stored row with invalid JSON does not make reads throw', () => {
    const file = tempDb()
    const service = new SessionService(file)
    const session = service.createSession('checkout')
    service.addEvent(session.id, 'info', { message: 'fine' })
    service.addEvent(session.id, 'info', { message: 'to be corrupted' })
    const raw = new Database(file)
    raw.prepare('UPDATE p2_session_events SET data = ? WHERE session_id = ? AND sequence = 1').run('{not json', session.id)
    raw.close()

    expect(() => service.getAllSessions()).not.toThrow()
    const events = service.getSession(session.id)?.events ?? []
    expect(events[0]?.payload).toEqual({ message: 'fine' })
    expect(events[1]?.payload).toMatchObject({ unreadable: true })
  })
})
