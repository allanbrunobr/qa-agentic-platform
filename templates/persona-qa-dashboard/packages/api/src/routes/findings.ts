import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDb, schema } from '../db/index.js';
import { resolveFindingScreenshotPath } from '../services/screenshot-path.js';

const FindingsQuerySchema = z.object({
  severity: z
    .enum(['critical', 'high', 'medium', 'low', 'info'])
    .optional(),
  agent: z.string().optional(),
  run_id: z.coerce.number().int().positive().optional(),
});

function getProjectDir(): string {
  return (
    process.env['PERSONA_QA_PROJECT_DIR'] ??
    path.resolve(process.cwd(), '../../..')
  );
}

export async function findingsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/findings - list findings with optional filters
  app.get('/api/findings', async (request, reply) => {
    const parseResult = FindingsQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid query parameters',
        details: parseResult.error.issues,
      });
    }

    const { severity, agent, run_id } = parseResult.data;
    const db = getDb();

    const conditions = [];

    if (severity !== undefined) {
      conditions.push(eq(schema.findings.severity, severity));
    }
    if (agent !== undefined) {
      conditions.push(eq(schema.findings.agent, agent));
    }
    if (run_id !== undefined) {
      conditions.push(eq(schema.findings.run_id, run_id));
    }

    const rows =
      conditions.length > 0
        ? await db
            .select()
            .from(schema.findings)
            .where(and(...conditions))
        : await db.select().from(schema.findings);

    return reply.send(rows);
  });

  // GET /api/findings/stats - finding stats by severity and agent
  app.get('/api/findings/stats', async (_request, reply) => {
    const db = getDb();

    const bySeverity = await db
      .select({
        severity: schema.findings.severity,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(schema.findings)
      .groupBy(schema.findings.severity);

    const byAgent = await db
      .select({
        agent: schema.findings.agent,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(schema.findings)
      .groupBy(schema.findings.agent);

    const byRun = await db
      .select({
        run_id: schema.findings.run_id,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(schema.findings)
      .groupBy(schema.findings.run_id);

    return reply.send({
      by_severity: bySeverity,
      by_agent: byAgent,
      by_run: byRun,
      total: bySeverity.reduce((sum, row) => sum + row.count, 0),
    });
  });

  // GET /api/findings/:id/screenshot - serve the screenshot image file
  app.get<{ Params: { id: string } }>(
    '/api/findings/:id/screenshot',
    async (request, reply) => {
      const findingId = parseInt(request.params.id, 10);
      if (isNaN(findingId)) {
        return reply.status(400).send({ error: 'Invalid finding ID' });
      }

      const db = getDb();
      const [finding] = await db
        .select({
          id: schema.findings.id,
          screenshot_path: schema.findings.screenshot_path,
        })
        .from(schema.findings)
        .where(eq(schema.findings.id, findingId));

      if (!finding) {
        return reply.status(404).send({ error: 'Finding not found' });
      }

      if (!finding.screenshot_path) {
        return reply
          .status(404)
          .send({ error: 'No screenshot available for this finding' });
      }

      // Only image files whose real path is inside the project are served (S-08).
      const projectDir = getProjectDir();
      const screenshotAbsPath = await resolveFindingScreenshotPath(projectDir, finding.screenshot_path);
      if (!screenshotAbsPath) {
        return reply
          .status(404)
          .send({ error: 'Screenshot file not found inside the project' });
      }

      const buffer = await fs.readFile(screenshotAbsPath);

      // Determine content type from extension
      const ext = path.extname(screenshotAbsPath).toLowerCase();
      const contentTypeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
      };
      const contentType = contentTypeMap[ext] ?? 'image/png';

      return reply.type(contentType).send(buffer);
    }
  );
}
