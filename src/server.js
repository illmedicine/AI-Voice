import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import pino from 'pino';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, assertConfig } from './config.js';
import { router } from './routes.js';
import { ravenRouter } from './raven-routes.js';
import { attachRealtime } from './realtime.js';
import { initDb, dbEnabled } from './db.js';
import { hydrateStore } from './store.js';
import { hydrateSessions } from './sessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    config.nodeEnv === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

assertConfig();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'media-src': ["'self'", 'blob:', 'data:'],
        'connect-src': ["'self'", 'https:', 'http:', 'ws:', 'wss:'],
      },
    },
  }),
);
app.use(
  cors({
    origin:
      config.corsOrigins.length === 0 || config.corsOrigins.includes('*')
        ? true
        : config.corsOrigins,
  }),
);
app.use(compression());
app.use(express.json({ limit: '15mb' }));
app.use(pinoHttp({ logger }));

// Serve the static test page from /public at the site root.
app.use(express.static(path.resolve(__dirname, '..', 'public'), { index: 'index.html' }));

// Generous limiter — tune to your needs. TTS + LLM calls are expensive,
// so we default to 60 req/min/IP across the API.
const limiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_PER_MIN || 60),
  standardHeaders: true,
  legacyHeaders: false,
  // Health checks and the static test page should never be limited.
  skip: (req) =>
    req.path === '/health' ||
    req.path === '/' ||
    req.path === '/api' ||
    req.path.startsWith('/assets/') ||
    req.path.endsWith('.html') ||
    req.path.endsWith('.css') ||
    req.path.endsWith('.js') ||
    req.path.endsWith('.ico'),
});
app.use(limiter);

// Raven app endpoints (Google SSO, profile, rooms, chat history).
app.use(ravenRouter);

app.use(router);

// 404
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logger.error({ err }, 'unhandled error');
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

const server = app.listen(config.port, () => {
  logger.info(
    `ai-voice-middleware listening on :${config.port} ` +
      `[dev=${process.env.RAVEN_DEV_MODE === '1'} ` +
      `google=${!!process.env.GOOGLE_CLIENT_IDS} ` +
      `db=${dbEnabled ? 'postgres' : 'json'}]`,
  );
});

// Hydrate persistent state asynchronously (non-blocking startup).
(async () => {
  try {
    if (dbEnabled) {
      await initDb(logger);
      await hydrateStore(logger);
      await hydrateSessions(logger);
    }
  } catch (err) {
    logger.error({ err }, 'database hydration failed; continuing with empty state');
  }
})();

// WebSocket presence + WebRTC signaling on /rt
attachRealtime(server, logger);

// Graceful shutdown
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Optional self-ping loop to keep free-tier hosts (Render, etc.) warm.
if (config.selfPing.url) {
  const ping = async () => {
    try {
      const r = await fetch(config.selfPing.url, { method: 'GET' });
      logger.debug({ status: r.status }, 'self-ping');
    } catch (e) {
      logger.warn({ err: e }, 'self-ping failed');
    }
  };
  setInterval(ping, Math.max(60_000, config.selfPing.intervalMs)).unref();
  // First ping after a short delay so the server is fully up.
  setTimeout(ping, 15_000).unref();
}
