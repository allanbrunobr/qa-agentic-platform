import { initDb, closeDb } from './db/index.js';
import { setLastSync } from './routes/stats.js';
import { syncDataDir } from './services/data-sync.js';
import { buildApp } from './app.js';
import { defaultRuntimeTokenPath, ensureRuntimeToken } from './security/runtime-token.js';
import { getSessionService } from './phase2/routes/sessions.js';

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

  // Sessions left pending/running by a process that died or was killed can never finish: close them
  // as failed so verdicts, metrics and the quality gate count them (B-07).
  const interrupted = getSessionService().failInterruptedSessions('process_restarted');
  if (interrupted.length > 0) {
    console.warn(`[startup] Marked ${interrupted.length} interrupted session(s) as failed`);
  }

  // Created on first start (or by the launcher before it), reused afterwards. Never logged.
  const tokenPath = defaultRuntimeTokenPath();
  const token = await ensureRuntimeToken(tokenPath);
  const app = await buildApp({ token });

  // Graceful shutdown handlers
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    // Runs in this process are abandoned by the shutdown: record them as failed, not running.
    try {
      getSessionService().failInterruptedSessions(`process_shutdown_${signal.toLowerCase()}`);
    } catch (err) {
      app.log.error(err);
    }
    await app.close();
    closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`[persona-qa/api] Server listening on http://${HOST}:${PORT}`);
    console.log(`[persona-qa/api] WebSocket endpoint: ws://${HOST}:${PORT}/ws/p2/sessions/:sessionId`);
    console.log(`[persona-qa/api] Health check: http://${HOST}:${PORT}/health`);
    console.log(`[persona-qa/api] Other requests need the token in ${tokenPath} (header x-agentic-token)`);
  } catch (err) {
    app.log.error(err);
    closeDb();
    process.exit(1);
  }
}

void start();
