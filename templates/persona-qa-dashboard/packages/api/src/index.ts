import { initDb, closeDb } from './db/index.js';
import { setLastSync } from './routes/stats.js';
import { syncDataDir } from './services/data-sync.js';
import { buildApp } from './app.js';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);
const HOST = process.env['HOST'] ?? '127.0.0.1';

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
