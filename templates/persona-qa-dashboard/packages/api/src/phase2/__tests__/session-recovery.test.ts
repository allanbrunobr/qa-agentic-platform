import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SessionService } from '../services/session-service.js'
import { buildScenarioQualityGateForSessions } from '../services/scenario-quality-gates.js'

// B-07 (docs/analise-20261109.md): a run interrupted by Ctrl+C, a crash or a reboot stayed "running"
// forever, its verdict stayed contract_evaluating, and the quality gate (which only counts final
// sessions) never saw it.

describe('failInterruptedSessions', () => {
  it('closes pending and running sessions as failed and leaves final ones alone', () => {
    const service = new SessionService(':memory:')
    const running = service.createSession('checkout')
    service.updateStatus(running.id, 'running')
    const pending = service.createSession('checkout')
    const complete = service.createSession('checkout')
    service.updateStatus(complete.id, 'complete')

    const closed = service.failInterruptedSessions('process_restarted')

    expect(closed.sort()).toEqual([running.id, pending.id].sort())
    expect(service.getSession(running.id)?.status).toBe('failed')
    expect(service.getSession(running.id)?.completedAt).toBeTruthy()
    expect(service.getSession(pending.id)?.status).toBe('failed')
    expect(service.getSession(complete.id)?.status).toBe('complete')
    const interruption = service.getSession(running.id)?.events.find((event) => event.type === 'interruption_recorded')
    expect((interruption?.payload ?? interruption?.data) as Record<string, unknown>).toEqual(expect.objectContaining({ reason: 'process_restarted' }))
  })

  it('makes interrupted runs count as failures in the quality gate', () => {
    const service = new SessionService(':memory:')
    for (let i = 0; i < 2; i += 1) {
      const session = service.createSession('checkout')
      service.updateStatus(session.id, 'running')
    }
    expect(buildScenarioQualityGateForSessions('checkout', service.getAllSessions()).recentFinalSessions).toBe(0)
    service.failInterruptedSessions('process_restarted')
    const gate = buildScenarioQualityGateForSessions('checkout', service.getAllSessions())
    expect(gate.recentFinalSessions).toBe(2)
    expect(gate.consecutiveFailures).toBe(2)
  })

  it('is a no-op when nothing is in flight', () => {
    expect(new SessionService(':memory:').failInterruptedSessions('process_restarted')).toEqual([])
  })

})

describe('the real API process', () => {
  // Starts src/index.ts as a child process on a temporary database: the startup must close a session
  // left running, and SIGTERM must close a session that is running at shutdown.
  it('closes interrupted sessions on startup and on SIGTERM', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'session-recovery-'))
    const dbPath = path.join(work, 'sessions.db')
    const seeded = new SessionService(dbPath)
    const leftRunning = seeded.createSession('checkout')
    seeded.updateStatus(leftRunning.id, 'running')

    const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
    // The child must not inherit vitest's variables: with VITEST set, SessionService uses :memory:.
    const parentEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')))
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: apiRoot,
      env: {
        ...parentEnv,
        DATABASE_URL: dbPath,
        PORT: '0',
        HOST: '127.0.0.1',
        NODE_ENV: 'production',
        LOG_LEVEL: 'error',
        AGENTIC_QA_API_TOKEN_PATH: path.join(work, 'runtime-api.token'),
        PERSONA_QA_DATA_DIR: path.join(work, 'data'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    try {
      await waitFor(() => output.includes('Server listening'), 20_000, () => output)
      expect(output).toContain('Marked 1 interrupted session(s) as failed')
      expect(new SessionService(dbPath).getSession(leftRunning.id)?.status).toBe('failed')

      const writer = new SessionService(dbPath)
      const inFlight = writer.createSession('checkout')
      writer.updateStatus(inFlight.id, 'running')

      const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
      child.kill('SIGTERM')
      expect(await exited).toBe(0)
      expect(new SessionService(dbPath).getSession(inFlight.id)?.status).toBe('failed')
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      await rm(work, { recursive: true, force: true })
    }
  }, 30_000)
})

async function waitFor(condition: () => boolean, timeoutMs: number, describe: () => string) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for the API to start:\n${describe()}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
