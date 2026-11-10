import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';
import { initDb, closeDb } from './db/index.js';
import { runsRoutes } from './routes/runs.js';
import { scenariosRoutes } from './routes/scenarios.js';
import { findingsRoutes } from './routes/findings.js';
import { statsRoutes } from './routes/stats.js';
import { settingsRoutes } from './routes/settings.js';
import { wsRoutes } from './routes/ws.js';
import { personasRoutes } from './routes/personas.js';
import { insightsRoutes } from './routes/insights.js';
import { syncRoutes } from './routes/sync.js';
import { domainDiscoveryRoutes } from './routes/domain-discovery.js';
import { codeGraphRoutes } from './routes/code-graph.js';
import { setLastSync } from './routes/stats.js';
import { syncDataDir } from './services/data-sync.js';
import { phase2SessionRoutes } from './phase2/routes/sessions.js';
import { phase2RunnerRoutes } from './phase2/routes/runner.js';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);
const HOST = process.env['HOST'] ?? '127.0.0.1';

async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      transport:
        process.env['NODE_ENV'] !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  const allowedOrigins = new Set([
    'http://127.0.0.1:5176',
    'http://localhost:5176',
    ...(process.env['AGENTIC_QA_WEB_ORIGIN'] ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
  ])
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true)
        return
      }
      callback(null, false)
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // Register WebSocket support
  await app.register(websocketPlugin);

  // Register all route handlers
  await app.register(runsRoutes);
  await app.register(scenariosRoutes);
  await app.register(findingsRoutes);
  await app.register(statsRoutes);
  await app.register(settingsRoutes);
  await app.register(wsRoutes);
  await app.register(personasRoutes);
  await app.register(insightsRoutes);
  await app.register(syncRoutes);
  await app.register(domainDiscoveryRoutes);
  await app.register(codeGraphRoutes);
  await app.register(phase2SessionRoutes);
  await app.register(phase2RunnerRoutes);

  // Health check endpoint
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  return app;
}

async function start(): Promise<void> {
  // Initialize database and create tables
  initDb();

  // Sync data directory on startup (best-effort; don't crash if data dir missing)
  try {
    await syncDataDir();
    setLastSync(new Date().toISOString(), 'startup');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[startup] Data sync skipped: ${message}`);
  }

  const app = await buildApp();

  // Graceful shutdown handlers
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    await app.close();
    closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`[persona-qa/api] Server listening on http://${HOST}:${PORT}`);
    console.log(`[persona-qa/api] WebSocket endpoint: ws://${HOST}:${PORT}/ws/runs/:runId`);
    console.log(`[persona-qa/api] Health check: http://${HOST}:${PORT}/health`);
  } catch (err) {
    app.log.error(err);
    closeDb();
    process.exit(1);
  }
}

void start();
