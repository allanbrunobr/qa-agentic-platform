import type { FastifyInstance } from 'fastify';
import { sql, desc } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { buildContractEvaluation } from '../phase2/services/contract-evaluation.js';
import { filterSessionsForAvailableScenarios, isAvailableScenarioId } from '../phase2/services/available-scenarios.js';
import { buildScenarioQualityGateMap } from '../phase2/services/scenario-quality-gates.js';
import { getSessionService } from '../phase2/routes/sessions.js';
import { loadRuntimeSettings, listRuntimeProviders } from '../services/runtime-settings.js';

// In-memory cache for last sync info (hydrated from sync_meta on first access)
let lastSyncTimestamp: string | null = null;
let lastSyncSource: string | null = null;
let syncHydrated = false;
const ACTIVE_RUN_STALE_MS = 60 * 60 * 1000;
type RuntimeConfigState = 'configured' | 'default' | 'missing';

function envValue(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function envState(names: string[], hasDefault = false): RuntimeConfigState {
  return envValue(...names) ? 'configured' : hasDefault ? 'default' : 'missing';
}

function getRuntimeConfigStatus() {
  const runtimeSettings = loadRuntimeSettings();
  return {
    provider: runtimeSettings.provider,
    supported_providers: listRuntimeProviders(),
    anthropic_key: envState(['ANTHROPIC_API_KEY', 'ANTHROPIC_API']),
    openai_key: envState(['OPENAI_API_KEY']),
    test_user: envState(['TEST_USER'], true),
    test_password: envState(['TEST_PASSWORD'], true),
    secondary_user: envState(['RECEPTIONIST_USER'], true),
    playwright_base_url: envState(['PLAYWRIGHT_BASE_URL'], true),
    target_app_url:
      envValue('PLAYWRIGHT_BASE_URL', 'GENERIC_API_BASE_URL', 'TARGET_API_BASE_URL', 'API_BASE_URL')
      ?? 'not configured',
    secret_values: 'masked',
  };
}

export function setLastSync(timestamp: string, source: string): void {
  lastSyncTimestamp = timestamp;
  lastSyncSource = source;
  syncHydrated = true;
}

export function getLastSyncInfo(): { timestamp: string | null; source: string | null } {
  if (!syncHydrated) {
    // Hydrate from the same sync_meta table that /api/sync/summary reads.
    // This guarantees /api/status and /api/sync/summary always agree.
    try {
      const db = getDb();
      const rows = db
        .select({ value: sql<string>`value` })
        .from(sql`sync_meta`)
        .where(sql`key = 'last_sync_summary'`)
        .all();
      if (rows.length > 0 && rows[0]) {
        const summary = JSON.parse(rows[0].value as string) as { timestamp?: string; source?: string };
        if (summary.timestamp) {
          lastSyncTimestamp = summary.timestamp;
          lastSyncSource = summary.source ?? null;
        }
      }
    } catch {
      // sync_meta table may not exist yet (first boot before syncRoutes registers)
    }
    syncHydrated = true;
  }
  return { timestamp: lastSyncTimestamp, source: lastSyncSource };
}

function hasTable(tableName: string): boolean {
  try {
    const db = getDb();
    const rows = db.all(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${tableName}`
    ) as Array<{ name: string }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/status - system health status for health strip
  app.get('/api/status', async (_request, reply) => {
    let dbStatus: 'ok' | 'error' = 'ok';
    try {
      const db = getDb();
      // Simple query to verify DB is responsive
      await db.select({ count: sql<number>`1` }).from(schema.runs).limit(1);
    } catch {
      dbStatus = 'error';
    }

    // Active workload info
    let activeRun: { id: number | string; status: string; started_at: string; source: 'runs' | 'p2_sessions' } | null = null;
    try {
      const db = getDb();
      const [running] = await db
        .select({
          id: schema.runs.id,
          status: schema.runs.status,
          started_at: schema.runs.started_at,
        })
        .from(schema.runs)
        .where(sql`${schema.runs.status} IN ('pending', 'running')`)
        .orderBy(desc(schema.runs.started_at))
        .limit(1);

      const activeCandidates: Array<{
        id: number | string;
        status: string;
        started_at: string;
        source: 'runs' | 'p2_sessions';
      }> = [];

      if (running) {
        activeCandidates.push({
          id: running.id,
          status: running.status,
          started_at: running.started_at,
          source: 'runs',
        });
      }

      if (hasTable('p2_sessions')) {
        const activeP2 = db.all(sql`
          SELECT session_id, status, COALESCE(started_at, created_at) AS started_at
          , scenario_id
          FROM p2_sessions
          WHERE status IN ('pending', 'running')
          ORDER BY COALESCE(started_at, created_at) DESC
          LIMIT 1
        `) as Array<{ session_id: string; status: string; started_at: string; scenario_id: string }>;

        if (activeP2[0] && isAvailableScenarioId(activeP2[0].scenario_id)) {
          activeCandidates.push({
            id: activeP2[0].session_id,
            status: activeP2[0].status,
            started_at: activeP2[0].started_at,
            source: 'p2_sessions',
          });
        }
      }

      activeRun = activeCandidates.sort(
        (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
      )[0] ?? null;

      if (activeRun) {
        const ageMs = Date.now() - new Date(activeRun.started_at).getTime();
        if (Number.isFinite(ageMs) && ageMs > ACTIVE_RUN_STALE_MS) {
          activeRun = null;
        }
      }
    } catch {
      // ignore — already handled via dbStatus
    }

    const syncInfo = getLastSyncInfo();
    let latestActivityAt: string | null = null;
    let latestActivitySource: 'runs' | 'p2_sessions' | null = null;

    try {
      const db = getDb();
      const latestCandidates: Array<{ timestamp: string; source: 'runs' | 'p2_sessions' }> = [];

      const [latestRun] = await db
        .select({
          started_at: schema.runs.started_at,
          completed_at: schema.runs.completed_at,
        })
        .from(schema.runs)
        .orderBy(desc(schema.runs.started_at))
        .limit(1);

      const latestRunActivity = latestRun?.completed_at ?? latestRun?.started_at ?? null;
      if (latestRunActivity) {
        latestCandidates.push({ timestamp: latestRunActivity, source: 'runs' });
      }

      if (hasTable('p2_sessions')) {
        const p2Rows = db.all(sql`
          SELECT COALESCE(completed_at, started_at, created_at) AS last_activity_at, scenario_id
          FROM p2_sessions
          ORDER BY COALESCE(completed_at, started_at, created_at) DESC
          LIMIT 20
        `) as Array<{ last_activity_at: string | null; scenario_id: string }>;
        const p2Activity = p2Rows.find((row) => row.last_activity_at && isAvailableScenarioId(row.scenario_id))?.last_activity_at ?? null;
        if (p2Activity) {
          latestCandidates.push({ timestamp: p2Activity, source: 'p2_sessions' });
        }
      }

      const latestActivity = latestCandidates.sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )[0];

      latestActivityAt = latestActivity?.timestamp ?? null;
      latestActivitySource = latestActivity?.source ?? null;
    } catch {
      latestActivityAt = null;
      latestActivitySource = null;
    }

    return reply.send({
      api: 'up',
      db: dbStatus,
      last_sync: syncInfo.timestamp,
      last_sync_source: syncInfo.source,
      latest_activity_at: latestActivityAt,
      latest_activity_source: latestActivitySource,
      runtime_config: getRuntimeConfigStatus(),
      active_run: activeRun
        ? {
            id: activeRun.id,
            status: activeRun.status,
            started_at: activeRun.started_at,
            source: activeRun.source,
          }
        : null,
    });
  });

  // GET /api/suite-health - aggregated test suite health data
  app.get('/api/suite-health', async (_request, reply) => {
    const db = getDb();

    const allScenarios = await db
      .select({ scenario_id: schema.scenarios.scenario_id, name: schema.scenarios.name })
      .from(schema.scenarios);

    const registeredIds = new Set(allScenarios.map(s => s.scenario_id));

    // -------------------------------------------------------------------
    // Find the most recent execution batch.
    //
    // A "batch" = runs started within BATCH_WINDOW_MS of each other.
    // When the suite triggers 3 specs in one pnpm invocation, their
    // started_at timestamps fall within seconds. We walk backwards
    // through completed runs and group by time proximity.
    // -------------------------------------------------------------------
    const BATCH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

    const completedRuns = await db
      .select({
        id: schema.runs.id,
        scenario_id: schema.runs.scenario_id,
        scenario_name: schema.runs.scenario_name,
        status: schema.runs.status,
        started_at: schema.runs.started_at,
        passed: schema.runs.passed,
        failed: schema.runs.failed,
        skipped: schema.runs.skipped,
        total_tests: schema.runs.total_tests,
      })
      .from(schema.runs)
      .where(sql`${schema.runs.status} IN ('complete', 'failed')`)
      .orderBy(desc(schema.runs.started_at));

    // Group into batches by time proximity
    type RunRow = typeof completedRuns[number];
    const batches: RunRow[][] = [];
    let currentBatch: RunRow[] = [];

    for (const run of completedRuns) {
      if (currentBatch.length === 0) {
        currentBatch.push(run);
      } else {
        const batchAnchor = new Date(currentBatch[0]!.started_at).getTime();
        const runTime = new Date(run.started_at).getTime();
        if (batchAnchor - runTime <= BATCH_WINDOW_MS) {
          currentBatch.push(run);
        } else {
          batches.push(currentBatch);
          currentBatch = [run];
        }
      }
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    // Find the most recent batch that covers all registered scenarios
    // (= a real full suite execution). Fall back to the most recent batch.
    let fullSuiteBatch: RunRow[] | null = null;
    const latestBatch: RunRow[] | null = batches[0] ?? null;

    for (const batch of batches) {
      const batchScenarios = new Set(batch.map(r => r.scenario_id));
      const coversAll = registeredIds.size > 0 &&
        [...registeredIds].every(id => batchScenarios.has(id));
      if (coversAll) {
        fullSuiteBatch = batch;
        break;
      }
    }

    const selectedBatch = fullSuiteBatch ?? latestBatch;
    const isFullSuiteRun = fullSuiteBatch !== null;

    // Deduplicate: keep only the latest run per scenario_id within batch
    const batchByScenario = new Map<string, RunRow>();
    if (selectedBatch) {
      for (const run of selectedBatch) {
        if (!batchByScenario.has(run.scenario_id)) {
          batchByScenario.set(run.scenario_id, run);
        }
      }
    }
    const scenarioRuns = [...batchByScenario.values()];

    // Aggregate the batch
    let suiteStatus: 'pass' | 'fail' = 'pass';
    let suiteTotalTests = 0;
    let suitePassed = 0;
    let suiteFailed = 0;
    let suiteSkipped = 0;
    let suiteLatestStartedAt: string | null = null;
    let suiteEarliestStartedAt: string | null = null;

    for (const r of scenarioRuns) {
      suiteTotalTests += r.total_tests;
      suitePassed += r.passed;
      suiteFailed += r.failed;
      suiteSkipped += r.skipped;
      if (r.status === 'failed') suiteStatus = 'fail';
      if (!suiteLatestStartedAt || r.started_at > suiteLatestStartedAt) {
        suiteLatestStartedAt = r.started_at;
      }
      if (!suiteEarliestStartedAt || r.started_at < suiteEarliestStartedAt) {
        suiteEarliestStartedAt = r.started_at;
      }
    }

    const scenariosWithRuns = new Set(scenarioRuns.map(r => r.scenario_id));
    const scenariosWithoutRuns = allScenarios.filter(s => !scenariosWithRuns.has(s.scenario_id));
    const passedScenarios = scenarioRuns.filter(r => r.status === 'complete').length;
    const failedScenarios = scenarioRuns.filter(r => r.status === 'failed').length;

    // Stale data: latest run older than 24h
    const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const isStale = !suiteLatestStartedAt || suiteLatestStartedAt < staleThreshold;

    // DB clean heuristic: total runs > 100
    const [totalRunsRow] = await db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(schema.runs);
    const dbCleanRequired = (totalRunsRow?.count ?? 0) > 100;

    return reply.send({
      last_run: scenarioRuns.length > 0
        ? {
            status: suiteStatus,
            started_at: suiteLatestStartedAt!,
            batch_started_at: suiteEarliestStartedAt!,
            total_tests: suiteTotalTests,
            passed: suitePassed,
            failed: suiteFailed,
            skipped: suiteSkipped,
            scenario_count: scenarioRuns.length,
            is_full_suite: isFullSuiteRun,
          }
        : null,
      scenarios: scenarioRuns.map(r => ({
        scenario_id: r.scenario_id,
        scenario_name: r.scenario_name,
        status: r.status === 'complete' ? 'pass' as const : 'fail' as const,
        passed: r.passed,
        failed: r.failed,
        started_at: r.started_at,
      })),
      passed_scenarios: passedScenarios,
      failed_scenarios: failedScenarios,
      scenarios_without_runs: scenariosWithoutRuns.map(s => ({
        scenario_id: s.scenario_id,
        name: s.name,
      })),
      is_stale: isStale,
      db_clean_required: dbCleanRequired,
    });
  });

  // GET /api/stats - dashboard overview stats
  app.get('/api/stats', async (_request, reply) => {
    const db = getDb();

    // Total runs
    const [totalRunsRow] = await db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(schema.runs);

    const totalRuns = totalRunsRow?.count ?? 0;

    // Complete runs
    const [completeRunsRow] = await db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(schema.runs)
      .where(sql`${schema.runs.status} = 'complete'`);

    const completeRuns = completeRunsRow?.count ?? 0;

    // Failed runs
    const [failedRunsRow] = await db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(schema.runs)
      .where(sql`${schema.runs.status} = 'failed'`);

    const failedRuns = failedRunsRow?.count ?? 0;

    // Pass rate (based on runs where passed >= failed among complete runs)
    const passRate =
      completeRuns > 0
        ? Math.round((completeRuns / (completeRuns + failedRuns)) * 100)
        : 0;

    // Average duration (ms) for complete runs
    const [avgDurationRow] = await db
      .select({
        avg: sql<number>`avg(${schema.runs.duration_ms})`.as('avg'),
      })
      .from(schema.runs)
      .where(sql`${schema.runs.status} = 'complete' AND ${schema.runs.duration_ms} IS NOT NULL`);

    const avgDurationMs = avgDurationRow?.avg ? Math.round(avgDurationRow.avg) : null;

    // Total findings
    const [totalFindingsRow] = await db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(schema.findings);

    const totalFindings = totalFindingsRow?.count ?? 0;

    // Critical + high findings
    const [criticalHighRow] = await db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(schema.findings)
      .where(sql`${schema.findings.severity} IN ('critical', 'high')`);

    const criticalHighFindings = criticalHighRow?.count ?? 0;

    // Findings trend: last 10 runs with their findings_count
    const recentRuns = await db
      .select({
        id: schema.runs.id,
        started_at: schema.runs.started_at,
        status: schema.runs.status,
        findings_count: schema.runs.findings_count,
        critical_count: schema.runs.critical_count,
        high_count: schema.runs.high_count,
        passed: schema.runs.passed,
        failed: schema.runs.failed,
        duration_ms: schema.runs.duration_ms,
      })
      .from(schema.runs)
      .orderBy(desc(schema.runs.started_at))
      .limit(10);

    // Scenario count
    const [scenarioCountRow] = await db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(schema.scenarios);

    const totalScenarios = scenarioCountRow?.count ?? 0;

    let agenticStats = {
      total_sessions: 0,
      complete_sessions: 0,
      failed_sessions: 0,
      running_sessions: 0,
      multi_agent_sessions: 0,
      total_findings: 0,
      last_activity_at: null as string | null,
      contract_adherence: {
        violated: 0,
        drift: 0,
        compliant: 0,
        no_contract: 0,
        hard_violations: 0,
        drift_signals: 0,
      },
      scenario_quality_gates: {
        open: 0,
        review_required: 0,
        restricted: 0,
      },
    };

    if (hasTable('p2_sessions')) {
      const p2Summary = db.all(sql`
        SELECT
          COUNT(*) AS total_sessions,
          SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete_sessions,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_sessions,
          SUM(CASE WHEN status IN ('pending', 'running') THEN 1 ELSE 0 END) AS running_sessions,
          SUM(CASE WHEN scenario_id LIKE '%multi_role%' THEN 1 ELSE 0 END) AS multi_agent_sessions,
          MAX(COALESCE(completed_at, started_at, created_at)) AS last_activity_at
        FROM p2_sessions
      `) as Array<{
        total_sessions: number | null;
        complete_sessions: number | null;
        failed_sessions: number | null;
        running_sessions: number | null;
        multi_agent_sessions: number | null;
        last_activity_at: string | null;
      }>;

      const p2Findings = hasTable('p2_session_findings')
        ? ((db.all(sql`SELECT COUNT(*) AS count FROM p2_session_findings`) as Array<{ count: number | null }>)[0]?.count ?? 0)
        : 0;

      const validSessions = filterSessionsForAvailableScenarios(getSessionService().getAllSessions())
      const contractAdherence = validSessions.reduce(
        (summary, session) => {
          const evaluation = buildContractEvaluation(session).contractEvaluation;
          const verdict = evaluation?.verdict ?? null;
          switch (verdict) {
            case 'contract_violated':
              summary.violated += 1;
              break;
            case 'contract_drift':
              summary.drift += 1;
              break;
            case 'contract_compliant':
              summary.compliant += 1;
              break;
            default:
              summary.no_contract += 1;
          }
          summary.hard_violations += evaluation?.hardViolations ?? 0;
          summary.drift_signals += evaluation?.driftSignals ?? 0;
          return summary;
        },
        {
          violated: 0,
          drift: 0,
          compliant: 0,
          no_contract: 0,
          hard_violations: 0,
          drift_signals: 0,
        },
      );

      const scenarioQualityGates = Object.values(buildScenarioQualityGateMap(getSessionService())).reduce(
        (summary, gate) => {
          switch (gate.status) {
            case 'restricted':
              summary.restricted += 1;
              break;
            case 'review_required':
              summary.review_required += 1;
              break;
            default:
              summary.open += 1;
          }
          return summary;
        },
        { open: 0, review_required: 0, restricted: 0 },
      );

      agenticStats = {
        total_sessions: p2Summary[0]?.total_sessions ?? 0,
        complete_sessions: p2Summary[0]?.complete_sessions ?? 0,
        failed_sessions: p2Summary[0]?.failed_sessions ?? 0,
        running_sessions: p2Summary[0]?.running_sessions ?? 0,
        multi_agent_sessions: p2Summary[0]?.multi_agent_sessions ?? 0,
        total_findings: p2Findings,
        last_activity_at: p2Summary[0]?.last_activity_at ?? null,
        contract_adherence: contractAdherence,
        scenario_quality_gates: scenarioQualityGates,
      };
    }

    return reply.send({
      total_runs: totalRuns,
      complete_runs: completeRuns,
      failed_runs: failedRuns,
      pass_rate: passRate,
      avg_duration_ms: avgDurationMs,
      total_findings: totalFindings,
      critical_high_findings: criticalHighFindings,
      total_scenarios: totalScenarios,
      findings_trend: recentRuns,
      agentic: agenticStats,
    });
  });
}
