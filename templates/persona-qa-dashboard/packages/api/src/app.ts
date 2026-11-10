import Fastify, { type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';
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
import { phase2SessionRoutes } from './phase2/routes/sessions.js';
import { phase2RunnerRoutes } from './phase2/routes/runner.js';
import {
  extraAllowedHostnames,
  localWebOrigins,
  registerLocalRequestGuard,
} from './security/local-request-guard.js';

export interface BuildAppOptions {
  /** Local API token, required on every request except GET/HEAD /health (see security/runtime-token.ts). */
  token: string;
  logger?: FastifyServerOptions['logger'];
  env?: NodeJS.ProcessEnv;
}

function defaultLogger(env: NodeJS.ProcessEnv): FastifyServerOptions['logger'] {
  return {
    level: env['LOG_LEVEL'] ?? 'info',
    transport:
      env['NODE_ENV'] !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  };
}

export async function buildApp(options: BuildAppOptions) {
  const env = options.env ?? process.env;
  const app = Fastify({ logger: options.logger ?? defaultLogger(env) });

  const allowedOrigins = localWebOrigins(env);

  // The WebSocket plugin goes first: its onRequest hook marks upgrade requests, and its onResponse hook
  // destroys the raw socket of an upgrade that was answered with plain HTTP. If the guard ran before
  // that marking, a rejected upgrade would leave its socket open.
  await app.register(websocketPlugin);

  // Registered before CORS and every route: onRequest hooks run in registration order, so a request
  // with a foreign Host or Origin is rejected before CORS answers a preflight or any handler runs.
  registerLocalRequestGuard(app, {
    allowedOrigins,
    extraHostnames: extraAllowedHostnames(env),
    token: options.token,
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true)
        return
      }
      callback(null, false)
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Agentic-Token'],
    credentials: true,
  });

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
