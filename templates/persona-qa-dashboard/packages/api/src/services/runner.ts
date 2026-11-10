import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { syncDataDir, normalizeScenarioId } from './data-sync.js';
import { parseLogLine } from './log-parser.js';

const TIMEOUT_MS = parseInt(process.env['PERSONA_QA_TIMEOUT_MS'] ?? '600000', 10);
const KILL_GRACE_MS = 5000;

type LogHandler = (line: string) => void;
type StatusHandler = (status: string) => void;

interface RunSubscribers {
  logHandlers: Set<LogHandler>;
  statusHandlers: Set<StatusHandler>;
}

const subscribers = new Map<number, RunSubscribers>();

export function subscribeToRun(
  runId: number,
  logHandler: LogHandler,
  statusHandler: StatusHandler
): void {
  if (!subscribers.has(runId)) {
    subscribers.set(runId, { logHandlers: new Set(), statusHandlers: new Set() });
  }
  const subs = subscribers.get(runId)!;
  subs.logHandlers.add(logHandler);
  subs.statusHandlers.add(statusHandler);
}

export function unsubscribeFromRun(
  runId: number,
  logHandler: LogHandler,
  statusHandler: StatusHandler
): void {
  const subs = subscribers.get(runId);
  if (!subs) return;
  subs.logHandlers.delete(logHandler);
  subs.statusHandlers.delete(statusHandler);
  if (subs.logHandlers.size === 0 && subs.statusHandlers.size === 0) {
    subscribers.delete(runId);
  }
}

function emitLog(runId: number, line: string): void {
  const subs = subscribers.get(runId);
  if (!subs) return;
  for (const handler of subs.logHandlers) {
    handler(line);
  }
}

function emitStatus(runId: number, status: string): void {
  const subs = subscribers.get(runId);
  if (!subs) return;
  for (const handler of subs.statusHandlers) {
    handler(status);
  }
}

function getProjectDir(): string {
  return (
    process.env['PERSONA_QA_PROJECT_DIR'] ??
    path.resolve(process.cwd(), '../../..')
  );
}

export async function triggerRun(scenarioId?: string): Promise<number> {
  const db = getDb();
  const now = new Date().toISOString();
  const sessionId = `session-${Date.now()}`;

  // Normalize scenario ID to canonical underscore format
  const normalizedScenarioId = scenarioId ? normalizeScenarioId(scenarioId) : undefined;

  // Resolve scenario name from DB if scenario_id provided
  let scenarioName = normalizedScenarioId ?? 'all';
  if (normalizedScenarioId) {
    const [sc] = await db
      .select({ name: schema.scenarios.name })
      .from(schema.scenarios)
      .where(eq(schema.scenarios.scenario_id, normalizedScenarioId));
    if (sc) scenarioName = sc.name;
  }

  const [inserted] = await db
    .insert(schema.runs)
    .values({
      scenario_id: normalizedScenarioId ?? 'all',
      scenario_name: scenarioName,
      session_id: sessionId,
      status: 'pending',
      started_at: now,
      run_source: 'dashboard',
    })
    .returning({ id: schema.runs.id });

  if (!inserted) {
    throw new Error('Failed to create run record');
  }

  const runId = inserted.id;

  // Write metadata.json to the run's data directory
  const projectDir = getProjectDir();
  const dataDir =
    process.env['PERSONA_QA_DATA_DIR'] ??
    path.join(projectDir, 'integration-test', 'persona-tests');
  const runDataDir = path.join(dataDir, 'runs', sessionId);
  try {
    await fs.mkdir(runDataDir, { recursive: true });
    await fs.writeFile(
      path.join(runDataDir, 'metadata.json'),
      JSON.stringify({
        run_source: 'dashboard',
        suite_type: normalizedScenarioId ? 'single' : 'full',
        clean_db_before_run: false,
        started_by: 'dashboard-ui',
        scenario_id: normalizedScenarioId ?? 'all',
        session_id: sessionId,
      }, null, 2),
    );
  } catch (err) {
    console.warn(`[runner] Failed to write metadata.json: ${err instanceof Error ? err.message : err}`);
  }

  // Start async execution — do not await
  executeRun(runId, normalizedScenarioId).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[runner] Run ${runId} encountered unhandled error: ${message}`);
  });

  return runId;
}

async function executeRun(runId: number, scenarioId?: string): Promise<void> {
  const db = getDb();
  const projectDir = getProjectDir();

  await db
    .update(schema.runs)
    .set({ status: 'running' })
    .where(eq(schema.runs.id, runId));

  emitStatus(runId, 'running');

  const startTime = Date.now();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PERSONA_QA_PROJECT_DIR: projectDir,
    FORCE_COLOR: '0',
  };

  if (scenarioId) {
    env['PERSONA_QA_SCENARIO'] = scenarioId;
  }

  // Build Playwright args — filter to specific spec file when scenarioId given
  const args = ['test:persona-qa'];
  if (scenarioId) {
    // scenario_id uses underscores (quarterly_reorder), spec files use dashes (quarterly-reorder.spec.ts)
    const specFile = `persona-tests/specs/${scenarioId.replace(/_/g, '-')}.spec.ts`;
    args.push('--', specFile);
  }

  return new Promise<void>((resolve) => {
    const child = spawn('pnpm', args, {
      cwd: projectDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let timedOut = false;

    // Kill stuck processes after timeout
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Force kill after grace period if still alive
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_MS);
    }, TIMEOUT_MS);

    // Collect all output to parse test counts at the end
    const allLines: string[] = [];

    const handleLine = (line: string): void => {
      allLines.push(line);
      const logEvent = parseLogLine(line);
      emitLog(runId, JSON.stringify(logEvent));
    };

    let stdoutBuf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        handleLine(line);
      }
    });

    let stderrBuf = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        handleLine(`[stderr] ${line}`);
      }
    });

    child.on('close', async (code) => {
      clearTimeout(timeoutHandle);

      // Flush remaining buffers
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      if (stderrBuf.trim()) handleLine(`[stderr] ${stderrBuf}`);

      const durationMs = Date.now() - startTime;
      const succeeded = !timedOut && code === 0;
      const finalStatus = succeeded ? 'complete' : 'failed';
      const errorMessage = timedOut ? `Timeout after ${TIMEOUT_MS}ms` : undefined;

      // Parse test counts from Playwright output
      // Playwright summary lines look like: "  15 passed (2m 3s)" or "  2 failed" or "  15 passed, 1 failed (2m 3s)"
      let totalPassed = 0;
      let totalFailed = 0;
      let totalSkipped = 0;
      const fullOutput = allLines.join('\n');
      const passedMatch = fullOutput.match(/(\d+)\s+passed/);
      const failedMatch = fullOutput.match(/(\d+)\s+failed/);
      const skippedMatch = fullOutput.match(/(\d+)\s+skipped/);
      if (passedMatch?.[1]) totalPassed = parseInt(passedMatch[1], 10);
      if (failedMatch?.[1]) totalFailed = parseInt(failedMatch[1], 10);
      if (skippedMatch?.[1]) totalSkipped = parseInt(skippedMatch[1], 10);
      const totalTests = totalPassed + totalFailed + totalSkipped;

      try {
        // Wait for filesystem writes to flush before syncing
        await new Promise((r) => setTimeout(r, 500));

        // Sync data dir to pick up new context JSON files written by test run
        await syncDataDir();

        // Re-fetch run to get counts populated by syncDataDir
        const [updatedRun] = await db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, runId));

        await db
          .update(schema.runs)
          .set({
            status: finalStatus,
            completed_at: new Date().toISOString(),
            duration_ms: durationMs,
            total_tests: totalTests || updatedRun?.total_tests || 0,
            passed: totalPassed || updatedRun?.passed || 0,
            failed: totalFailed || updatedRun?.failed || 0,
            skipped: totalSkipped || updatedRun?.skipped || 0,
            findings_count: updatedRun?.findings_count ?? 0,
            critical_count: updatedRun?.critical_count ?? 0,
            high_count: updatedRun?.high_count ?? 0,
            error_message: errorMessage ?? null,
          })
          .where(eq(schema.runs.id, runId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[runner] Failed to finalize run ${runId}: ${message}`);

        await db
          .update(schema.runs)
          .set({
            status: 'failed',
            completed_at: new Date().toISOString(),
            duration_ms: durationMs,
            error_message: errorMessage ?? message,
          })
          .where(eq(schema.runs.id, runId));
      }

      emitStatus(runId, finalStatus);
      resolve();
    });

    child.on('error', async (err) => {
      clearTimeout(timeoutHandle);
      console.error(`[runner] Failed to spawn process for run ${runId}: ${err.message}`);
      const durationMs = Date.now() - startTime;

      await db
        .update(schema.runs)
        .set({
          status: 'failed',
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
          error_message: err.message,
        })
        .where(eq(schema.runs.id, runId));

      emitLog(runId, `[error] Failed to start test process: ${err.message}`);
      emitStatus(runId, 'failed');
      resolve();
    });
  });
}
