import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { pool } from './db.js';

async function main() {
  await migrate();
  if (process.env.SEED_ON_START === 'true') {
    const { seed } = await import('./seed.js').catch(() => ({}));
    if (seed) await seed();
  }
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[api] PrivateHire API listening on http://localhost:${config.port}  (${config.env})`);
  });
  const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error('[api] failed to start:', e);
  process.exit(1);
});
