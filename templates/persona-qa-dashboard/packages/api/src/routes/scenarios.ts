import type { FastifyInstance } from 'fastify';
import { eq, desc, sql } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { getDb, schema } from '../db/index.js';

interface ScenarioYaml {
  id?: string;
  name?: string;
  description?: string;
  steps?: Array<{
    id?: string;
    description?: string;
    agent?: string;
    [key: string]: unknown;
  }>;
  agents?: string[];
  [key: string]: unknown;
}

function getScenariosDir(): string {
  const projectDir =
    process.env['PERSONA_QA_PROJECT_DIR'] ??
    path.resolve(process.cwd(), '../../..');
  const dataDir =
    process.env['PERSONA_QA_DATA_DIR'] ??
    path.join(projectDir, 'integration-test', 'persona-tests');
  return path.join(dataDir, 'scenarios');
}

async function readScenarioYaml(filePath: string): Promise<ScenarioYaml | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return yaml.load(content) as ScenarioYaml;
  } catch {
    return null;
  }
}

function normalizeScenarioId(raw: string): string {
  return raw.replace(/-/g, '_');
}

export async function scenariosRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/scenarios - list all scenarios from DB (synced from YAML files)
  app.get('/api/scenarios', async (_request, reply) => {
    const db = getDb();
    const rows = await db.select().from(schema.scenarios);
    return reply.send(rows);
  });

  // GET /api/scenarios/:id - get scenario detail with steps from YAML
  app.get<{ Params: { id: string } }>('/api/scenarios/:id', async (request, reply) => {
    const scenarioId = normalizeScenarioId(request.params.id);
    const db = getDb();

    const [scenario] = await db
      .select()
      .from(schema.scenarios)
      .where(eq(schema.scenarios.scenario_id, scenarioId));

    if (!scenario) {
      return reply.status(404).send({ error: 'Scenario not found' });
    }

    // Attempt to load raw YAML for full step detail
    const scenariosDir = getScenariosDir();
    let yamlData: ScenarioYaml | null = null;

    try {
      const files = await fs.readdir(scenariosDir);
      const hyphenated = scenarioId.replace(/_/g, '-');
      const match = files.find(
        (f) =>
          f.endsWith('.yaml') || f.endsWith('.yml')
            ? f.replace(/\.(yaml|yml)$/, '') === scenarioId ||
              f.replace(/\.(yaml|yml)$/, '') === hyphenated ||
              f.startsWith(scenarioId) ||
              f.startsWith(hyphenated)
            : false
      );
      if (match) {
        yamlData = await readScenarioYaml(path.join(scenariosDir, match));
      }
    } catch {
      // YAML dir may not exist yet; return DB record only
    }

    return reply.send({
      ...scenario,
      steps: yamlData?.steps ?? [],
      raw: yamlData,
    });
  });

  // GET /api/runs/:id/timeline - build timeline events for a completed run
  app.get<{ Params: { id: string } }>('/api/runs/:id/timeline', async (request, reply) => {
    const runId = parseInt(request.params.id, 10);
    if (isNaN(runId)) {
      return reply.status(400).send({ error: 'Invalid run ID' });
    }

    const db = getDb();
    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));

    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    const runFindings = await db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.run_id, runId));

    // Build timeline events from run metadata and findings
    interface TimelineEvent {
      id: string;
      type: 'setup' | 'artifact' | 'finding' | 'scenario_complete' | 'scenario_failed' | 'sync';
      label: string;
      timestamp: string;
      durationFromPrev: number | null;
    }

    const events: TimelineEvent[] = [];
    const startMs = new Date(run.started_at).getTime();

    // Helper: duration from previous event
    function durationFrom(ts: string): number {
      const prev = events.length > 0 ? events[events.length - 1]! : null;
      if (!prev) return 0;
      return new Date(ts).getTime() - new Date(prev.timestamp).getTime();
    }

    // 1. Setup started
    events.push({
      id: `${runId}-setup`,
      type: 'setup',
      label: 'Setup started',
      timestamp: run.started_at,
      durationFromPrev: null,
    });

    // 2. Artifacts written — infer from test counts (artifacts are generated
    //    once the runner writes results.json, screenshots, etc.)
    //    We place this between setup and findings using an estimated timestamp.
    const hasArtifacts = run.total_tests > 0 || run.findings_count > 0;
    if (hasArtifacts) {
      // Estimate artifact timestamp: midpoint between start and first finding
      //   (or midpoint to completion if no findings).
      const sortedFindings = [...runFindings].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      const anchorMs = sortedFindings.length > 0
        ? new Date(sortedFindings[0]!.timestamp).getTime()
        : run.completed_at
          ? new Date(run.completed_at).getTime()
          : startMs;
      const artifactTs = new Date(startMs + (anchorMs - startMs) / 2).toISOString();
      events.push({
        id: `${runId}-artifact`,
        type: 'artifact',
        label: `Artifacts generated (${run.total_tests} tests, ${run.findings_count} findings)`,
        timestamp: artifactTs,
        durationFromPrev: durationFrom(artifactTs),
      });
    }

    // 3. Findings emitted (sorted by timestamp)
    const sortedFindings = [...runFindings].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    if (sortedFindings.length > 0) {
      const firstFindingTs = sortedFindings[0]!.timestamp;
      events.push({
        id: `${runId}-findings`,
        type: 'finding',
        label: `${sortedFindings.length} finding${sortedFindings.length !== 1 ? 's' : ''} emitted`,
        timestamp: firstFindingTs,
        durationFromPrev: durationFrom(firstFindingTs),
      });
    }

    // 4. Scenario completed or failed
    if (run.completed_at) {
      const isFailed = run.status === 'failed';
      events.push({
        id: `${runId}-scenario`,
        type: isFailed ? 'scenario_failed' : 'scenario_complete',
        label: isFailed
          ? `Scenario failed${run.error_message ? `: ${run.error_message}` : ''}`
          : 'Scenario completed successfully',
        timestamp: run.completed_at,
        durationFromPrev: durationFrom(run.completed_at),
      });

      // 5. Sync finalized
      events.push({
        id: `${runId}-sync`,
        type: 'sync',
        label: 'Sync completed',
        timestamp: run.completed_at,
        durationFromPrev: 0,
      });
    }

    return reply.send({ run_id: runId, events });
  });

  // GET /api/scenarios/:id/runs - paginated runs for a scenario
  app.get<{ Params: { id: string }; Querystring: { page?: string; limit?: string } }>(
    '/api/scenarios/:id/runs',
    async (request, reply) => {
      const scenarioId = normalizeScenarioId(request.params.id);
      const page = Math.max(1, parseInt(request.query.page ?? '1', 10) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(request.query.limit ?? '10', 10) || 10));
      const offset = (page - 1) * limit;

      const db = getDb();

      // Get total count
      const [countResult] = await db
        .select({ total: sql<number>`count(*)` })
        .from(schema.runs)
        .where(eq(schema.runs.scenario_id, scenarioId));

      const total = countResult?.total ?? 0;

      // Get paginated runs
      const rows = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.scenario_id, scenarioId))
        .orderBy(desc(schema.runs.started_at))
        .limit(limit)
        .offset(offset);

      return reply.send({
        runs: rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    }
  );

  // GET /api/scenarios/:id/stats - aggregated stats for scenario detail enhancement
  app.get<{ Params: { id: string } }>('/api/scenarios/:id/stats', async (request, reply) => {
    const scenarioId = normalizeScenarioId(request.params.id);
    const db = getDb();

    // Get scenario
    const [scenario] = await db
      .select()
      .from(schema.scenarios)
      .where(eq(schema.scenarios.scenario_id, scenarioId));

    if (!scenario) {
      return reply.status(404).send({ error: 'Scenario not found' });
    }

    // Latest run
    const [latestRun] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.scenario_id, scenarioId))
      .orderBy(desc(schema.runs.started_at))
      .limit(1);

    // Last 5 runs
    const recentRuns = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.scenario_id, scenarioId))
      .orderBy(desc(schema.runs.started_at))
      .limit(5);

    // Success rate from recent runs
    const totalRecent = recentRuns.length;
    const successCount = recentRuns.filter(r => r.status === 'complete').length;
    const successRate = totalRecent > 0 ? Math.round((successCount / totalRecent) * 100) : 0;

    // Average duration
    const durations = recentRuns
      .filter(r => r.duration_ms != null)
      .map(r => r.duration_ms!);
    const avgDurationMs = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

    // Total findings count and last finding
    const recentRunIds = recentRuns.map(r => r.id);
    let totalFindings = 0;
    let lastFinding = null;

    if (recentRunIds.length > 0) {
      const allFindings = await db
        .select()
        .from(schema.findings)
        .where(
          sql`${schema.findings.run_id} IN (${sql.join(
            recentRunIds.map(id => sql`${id}`),
            sql`, `
          )})`
        )
        .orderBy(desc(schema.findings.timestamp))
        .limit(50);

      totalFindings = allFindings.length;
      lastFinding = allFindings[0] ?? null;
    }

    return reply.send({
      scenario,
      latestRun: latestRun ?? null,
      recentRuns,
      successRate,
      avgDurationMs,
      totalFindings,
      lastFinding,
    });
  });
}
