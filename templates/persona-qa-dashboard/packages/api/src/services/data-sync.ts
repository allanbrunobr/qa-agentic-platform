import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

// -----------------------------------------------------------------------
// Types for YAML and JSON context files
// -----------------------------------------------------------------------

interface ScenarioYaml {
  id?: string;
  name?: string;
  description?: string;
  steps?: Array<{
    id?: string;
    agent?: string;
    [key: string]: unknown;
  }>;
  agents?: string[];
  [key: string]: unknown;
}

interface FindingJson {
  finding_id?: string;
  id?: string;
  agent?: string;
  step?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title?: string;
  expected?: string;
  actual?: string;
  screenshot_path?: string;
  screenshot?: string;
  timestamp?: string;
}

// -----------------------------------------------------------------------
// Zod schemas for runtime validation
// -----------------------------------------------------------------------

const FindingJsonSchema = z.object({
  finding_id: z.string().optional(),
  id: z.string().optional(),
  agent: z.string().optional(),
  step: z.string().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  title: z.string().optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  screenshot_path: z.string().optional(),
  screenshot: z.string().optional(),
  timestamp: z.string().optional(),
});

const ContextJsonSchema = z.object({
  session_id: z.string(),
  scenario_id: z.string(),
  scenario_name: z.string().optional(),
  status: z.enum(['pending', 'running', 'complete', 'failed']),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  duration_ms: z.number().optional(),
  total_tests: z.number().optional(),
  passed: z.number().optional(),
  failed: z.number().optional(),
  skipped: z.number().optional(),
  findings: z.array(FindingJsonSchema).optional(),
  run_source: z.string().optional(),
  artifacts: z.record(z.string(), z.unknown()).optional(),
});

export const MetadataSchema = z.object({
  run_source: z.enum(['dashboard', 'cli', 'clean-run']).optional(),
  suite_type: z.string().optional(),
  clean_db_before_run: z.boolean().optional(),
  started_by: z.string().optional(),
  scenario_id: z.string().optional(),
  session_id: z.string().optional(),
});

export const ResultsSchema = z.object({
  session_id: z.string(),
  scenario_id: z.string(),
  status: z.enum(['pending', 'running', 'complete', 'failed']),
  total_tests: z.number().optional(),
  passed: z.number().optional(),
  failed: z.number().optional(),
  skipped: z.number().optional(),
  duration_ms: z.number().optional(),
  run_source: z.string().optional(),
}).passthrough();

export { ContextJsonSchema, FindingJsonSchema };

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function getDataDir(): string {
  const projectDir =
    process.env['PERSONA_QA_PROJECT_DIR'] ??
    path.resolve(process.cwd(), '../../..');
  return (
    process.env['PERSONA_QA_DATA_DIR'] ??
    path.join(projectDir, 'integration-test', 'persona-tests')
  );
}

async function listFiles(dir: string, ext: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.endsWith(ext))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function readYaml<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return yaml.load(content) as T;
  } catch {
    return null;
  }
}

function countUniqueAgents(steps: ScenarioYaml['steps']): number {
  if (!steps || steps.length === 0) return 0;
  const agents = new Set(steps.map((s) => s.agent).filter(Boolean));
  return agents.size;
}

/**
 * Normalize scenario IDs to use underscores as canonical internal format.
 * Prevents duplicate scenarios caused by dash vs underscore inconsistency.
 */
export function normalizeScenarioId(id: string): string {
  return id.replace(/-/g, '_');
}

// -----------------------------------------------------------------------
// Scenario sync
// -----------------------------------------------------------------------

async function syncScenarios(dataDir: string): Promise<void> {
  const db = getDb();
  const scenariosDir = path.join(dataDir, 'scenarios');
  const files = [
    ...(await listFiles(scenariosDir, '.yaml')),
    ...(await listFiles(scenariosDir, '.yml')),
  ];

  for (const filePath of files) {
    const wrapper = await readYaml<{ scenario?: ScenarioYaml } & ScenarioYaml>(filePath);
    if (!wrapper) continue;

    // YAML files nest data under `scenario:` key — unwrap if present
    const raw: ScenarioYaml = wrapper.scenario ?? wrapper;

    const rawScenarioId =
      raw.id ?? path.basename(filePath).replace(/\.(yaml|yml)$/, '');
    const scenarioId = normalizeScenarioId(rawScenarioId);
    const name = raw.name ?? scenarioId;
    const description = typeof raw.description === 'string' ? raw.description : null;
    const stepCount = Array.isArray(raw.steps) ? raw.steps.length : 0;
    const agentCount = Array.isArray(raw.agents)
      ? raw.agents.length
      : countUniqueAgents(raw.steps);

    // Upsert using SQLite ON CONFLICT
    const existing = await db
      .select({ id: schema.scenarios.id })
      .from(schema.scenarios)
      .where(eq(schema.scenarios.scenario_id, scenarioId));

    if (existing.length > 0) {
      await db
        .update(schema.scenarios)
        .set({ name, description, step_count: stepCount, agent_count: agentCount })
        .where(eq(schema.scenarios.scenario_id, scenarioId));
    } else {
      await db.insert(schema.scenarios).values({
        scenario_id: scenarioId,
        name,
        description,
        step_count: stepCount,
        agent_count: agentCount,
      });
    }
  }

  if (files.length > 0) {
    console.log(`[data-sync] Synced ${files.length} scenario(s)`);
  }
}

// -----------------------------------------------------------------------
// Context JSON sync
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// Shared: upsert a single run into DB from validated data
// -----------------------------------------------------------------------

interface IngestRunParams {
  sessionId: string;
  scenarioId: string;
  scenarioName: string;
  ctx: z.infer<typeof ContextJsonSchema>;
  metadata: z.infer<typeof MetadataSchema> | null;
  runSource: 'dashboard' | 'cli' | 'clean-run' | 'unknown';
  artifactsJson: string | null;
  validFindings: FindingJson[];
}

function ingestRun(params: IngestRunParams): void {
  const db = getDb();
  const {
    sessionId, scenarioId, scenarioName, ctx,
    metadata, runSource, artifactsJson, validFindings,
  } = params;

  const findingsCount = validFindings.length;
  const criticalCount = validFindings.filter((f) => f.severity === 'critical').length;
  const highCount = validFindings.filter((f) => f.severity === 'high').length;

  db.transaction((tx) => {
    const existing = tx
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.session_id, sessionId))
      .all();

    let runId: number;

    if (existing.length > 0 && existing[0]) {
      runId = existing[0].id;

      tx.update(schema.runs)
        .set({
          scenario_id: scenarioId,
          status: ctx.status ?? 'complete',
          completed_at: ctx.completed_at ?? null,
          duration_ms: ctx.duration_ms ?? null,
          total_tests: ctx.total_tests ?? 0,
          passed: ctx.passed ?? 0,
          failed: ctx.failed ?? 0,
          skipped: ctx.skipped ?? 0,
          findings_count: findingsCount,
          critical_count: criticalCount,
          high_count: highCount,
          run_source: runSource,
          artifacts: artifactsJson,
          suite_type: metadata?.suite_type ?? null,
          clean_db_before_run: metadata?.clean_db_before_run ?? null,
          started_by: metadata?.started_by ?? null,
        })
        .where(eq(schema.runs.id, runId))
        .run();

      tx.delete(schema.findings)
        .where(eq(schema.findings.run_id, runId))
        .run();
    } else {
      const inserted = tx.insert(schema.runs)
        .values({
          scenario_id: scenarioId,
          scenario_name: scenarioName,
          session_id: sessionId,
          status: ctx.status ?? 'complete',
          started_at: ctx.started_at ?? new Date().toISOString(),
          completed_at: ctx.completed_at ?? null,
          duration_ms: ctx.duration_ms ?? null,
          total_tests: ctx.total_tests ?? 0,
          passed: ctx.passed ?? 0,
          failed: ctx.failed ?? 0,
          skipped: ctx.skipped ?? 0,
          findings_count: findingsCount,
          critical_count: criticalCount,
          high_count: highCount,
          run_source: runSource,
          artifacts: artifactsJson,
          suite_type: metadata?.suite_type ?? null,
          clean_db_before_run: metadata?.clean_db_before_run ?? null,
          started_by: metadata?.started_by ?? null,
        })
        .returning({ id: schema.runs.id })
        .get();

      if (!inserted) return;
      runId = inserted.id;
    }

    if (validFindings.length > 0) {
      const now = new Date().toISOString();
      tx.insert(schema.findings).values(
        validFindings.map((f) => ({
          run_id: runId,
          finding_id: f.finding_id ?? f.id ?? `finding-${Math.random().toString(36).slice(2)}`,
          agent: f.agent ?? 'unknown',
          step: f.step ?? 'unknown',
          severity: f.severity ?? 'info',
          title: f.title ?? 'Untitled Finding',
          expected: f.expected ?? '',
          actual: f.actual ?? '',
          screenshot_path: f.screenshot_path ?? f.screenshot ?? null,
          timestamp: f.timestamp ?? now,
        }))
      ).run();
    }

    tx.update(schema.scenarios)
      .set({
        last_run_at: ctx.started_at ?? new Date().toISOString(),
        last_status: ctx.status ?? 'complete',
      })
      .where(eq(schema.scenarios.scenario_id, scenarioId))
      .run();
  });
}

// -----------------------------------------------------------------------
// Shared: validate findings array
// -----------------------------------------------------------------------

function validateFindings(findings: unknown[], sourceLabel: string): FindingJson[] {
  const valid: FindingJson[] = [];
  for (const f of findings) {
    const result = FindingJsonSchema.safeParse(f);
    if (result.success) {
      valid.push(result.data as FindingJson);
    } else {
      console.warn(`[data-sync] Invalid finding in ${sourceLabel}: ${result.error.message}`);
    }
  }
  return valid;
}

// -----------------------------------------------------------------------
// Per-run-directory sync (formal ingestion contract)
// Scans runs/<session_id>/ and sessions/<timestamp>/ directories
// -----------------------------------------------------------------------

async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function syncRunDirectories(dataDir: string): Promise<{ count: number; sessionIds: Set<string> }> {
  // Scan both runs/ (dashboard-created) and sessions/ (CLI/pipeline-created)
  const runDirs = [
    ...(await listSubdirectories(path.join(dataDir, 'runs'))),
    ...(await listSubdirectories(path.join(dataDir, 'sessions'))),
  ];

  let synced = 0;
  const ingestedSessionIds = new Set<string>();

  for (const runDir of runDirs) {
    // 1. Read metadata.json (the formal contract's source of truth)
    const metadataRaw = await readJson<unknown>(path.join(runDir, 'metadata.json'));
    const metadataParsed = MetadataSchema.safeParse(metadataRaw ?? {});
    const metadata = metadataParsed.success ? metadataParsed.data : null;
    if (metadataRaw && !metadataParsed.success) {
      console.warn(`[data-sync] Invalid metadata.json in ${runDir}: ${metadataParsed.error.message}`);
    }

    // 2. Read context JSON — look for context/<scenario>.json inside the run dir,
    //    or a top-level results.json
    const contextFiles = await listFiles(path.join(runDir, 'context'), '.json');
    const resultsRaw = await readJson<unknown>(path.join(runDir, 'results.json'));

    // Validate results.json if present
    if (resultsRaw) {
      const rParsed = ResultsSchema.safeParse(resultsRaw);
      if (!rParsed.success) {
        console.warn(`[data-sync] Invalid results.json in ${runDir}: ${rParsed.error.message}`);
      }
    }

    // Process each context file in this run directory
    for (const ctxFile of contextFiles) {
      const raw = await readJson<unknown>(ctxFile);
      if (!raw) continue;

      const parsed = ContextJsonSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn(`[data-sync] Invalid context file ${ctxFile}: ${parsed.error.message}`);
        continue;
      }
      const ctx = parsed.data;

      const scenarioId = normalizeScenarioId(ctx.scenario_id);
      const validFindings = validateFindings(ctx.findings ?? [], ctxFile);

      // run_source comes from metadata.json only — no heuristic fallback
      const runSource: IngestRunParams['runSource'] = metadata?.run_source ?? 'unknown';
      if (!metadata?.run_source) {
        console.warn(`[data-sync] No run_source in metadata for ${runDir} — using "unknown"`);
      }

      ingestRun({
        sessionId: ctx.session_id,
        scenarioId,
        scenarioName: ctx.scenario_name ?? scenarioId,
        ctx,
        metadata,
        runSource,
        artifactsJson: ctx.artifacts ? JSON.stringify(ctx.artifacts) : null,
        validFindings,
      });
      ingestedSessionIds.add(ctx.session_id);
      synced++;
    }

    // If no context files but metadata.json exists, try results.json as context
    if (contextFiles.length === 0 && resultsRaw) {
      const rParsed = ResultsSchema.safeParse(resultsRaw);
      if (rParsed.success) {
        const r = rParsed.data;
        const scenarioId = normalizeScenarioId(r.scenario_id);
        const runSource: IngestRunParams['runSource'] = metadata?.run_source ?? 'unknown';

        // Build a minimal context-compatible object from results
        const syntheticCtx: z.infer<typeof ContextJsonSchema> = {
          session_id: r.session_id,
          scenario_id: r.scenario_id,
          status: r.status,
          total_tests: r.total_tests,
          passed: r.passed,
          failed: r.failed,
          skipped: r.skipped,
          duration_ms: r.duration_ms,
        };

        ingestRun({
          sessionId: r.session_id,
          scenarioId,
          scenarioName: scenarioId,
          ctx: syntheticCtx,
          metadata,
          runSource,
          artifactsJson: null,
          validFindings: [],
        });
        ingestedSessionIds.add(r.session_id);
        synced++;
      }
    }
  }

  return { count: synced, sessionIds: ingestedSessionIds };
}

// -----------------------------------------------------------------------
// Legacy context/ sync (backwards compatibility for flat context files)
// Skips any session_id already ingested by the formal path to prevent
// overwriting metadata fields with null/'unknown'.
// -----------------------------------------------------------------------

async function syncContextFiles(dataDir: string, alreadyIngested: Set<string>): Promise<void> {
  const contextDir = path.join(dataDir, 'context');
  const files = await listFiles(contextDir, '.json');

  for (const filePath of files) {
    const raw = await readJson<unknown>(filePath);
    if (!raw) continue;

    const parsed = ContextJsonSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[data-sync] Invalid context file ${filePath}: ${parsed.error.message}`);
      continue;
    }
    const ctx = parsed.data;

    // Skip if this session was already ingested from a formal run directory
    if (alreadyIngested.has(ctx.session_id)) {
      continue;
    }

    const scenarioId = normalizeScenarioId(ctx.scenario_id);
    const validFindings = validateFindings(ctx.findings ?? [], filePath);

    // Legacy context files have no metadata.json — always 'unknown'
    ingestRun({
      sessionId: ctx.session_id,
      scenarioId,
      scenarioName: ctx.scenario_name ?? scenarioId,
      ctx,
      metadata: null,
      runSource: 'unknown',
      artifactsJson: ctx.artifacts ? JSON.stringify(ctx.artifacts) : null,
      validFindings,
    });
  }

  if (files.length > 0) {
    console.log(`[data-sync] Synced ${files.length} legacy context file(s)`);
  }
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

export async function syncDataDir(): Promise<void> {
  const dataDir = getDataDir();
  await syncScenarios(dataDir);

  // Formal ingestion: scan per-run directories first (runs/, sessions/)
  const { count: formalCount, sessionIds } = await syncRunDirectories(dataDir);

  // Legacy fallback: scan flat context/ directory for runs that were NOT
  // already ingested by the formal path. Prevents overwriting metadata
  // fields (run_source, suite_type, etc.) with null/'unknown'.
  await syncContextFiles(dataDir, sessionIds);

  if (formalCount > 0) {
    console.log(`[data-sync] Synced ${formalCount} run(s) from formal run directories`);
  }
}
