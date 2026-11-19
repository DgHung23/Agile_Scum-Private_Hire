import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { query } from './db.js';
import { wrap } from './middleware/validate.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { listEndpoints, registerRoutes } from './routes/index.js';
import { csrfGuard } from './middleware/auth.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(
    helmet({
      hsts: config.forceHttps,
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'upgrade-insecure-requests': config.forceHttps ? [] : null,
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com'],
          'img-src': ["'self'", 'data:'],
        },
      },
    }),
  );
  app.use(cors({ origin: config.corsOrigin.split(','), credentials: true }));
  app.use(express.json({ limit: '100kb' }));

  app.get(
    '/api/v1/health',
    wrap(async (_req, res) => {
      const { rows } = await query('SELECT now() AS time');
      res.json({ status: 'ok', db: 'up', time: rows[0].time, version: '1.0.0' });
    }),
  );

  app.use('/api', csrfGuard);
  const api = express.Router();
  registerRoutes(api);
  app.use('/api/v1', api);

  // API reference (Definition of Done line 12, red-team row 4): available in development only, never in production.
  if (!config.isProd) {
    app.get('/api/docs', (_req, res) => {
      const rows = listEndpoints();
      res.type('html').send(
        `<!doctype html><meta charset="utf-8"><title>Private Hire API</title><body style="font:14px system-ui;margin:24px">` +
          `<h1>Private Hire Cars API (development only)</h1><p>${rows.length} endpoints. Details: docs/API.md.</p><table>` +
          rows.map(([m, p]) => `<tr><td style="padding:2px 12px 2px 0"><b>${m}</b></td><td><code>${p}</code></td></tr>`).join('') +
          '</table></body>',
      );
    });
    app.get('/api/docs.json', (_req, res) => res.json({ endpoints: listEndpoints().map(([method, path]) => ({ method, path })) }));
  }
  app.use('/api', notFoundHandler);

  // Serve the built web app (single-container deployment). In dev, Vite serves the web app.
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
