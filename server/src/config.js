import 'dotenv/config';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

export const config = {
  env: env.NODE_ENV || 'development',
  isProd,
  port: Number(env.PORT || 4000),
  databaseUrl:
    env.DATABASE_URL || 'postgres://privatehire:privatehire_dev@localhost:5433/privatehire',
  corsOrigin: env.CORS_ORIGIN || 'http://localhost:5173',
  publicUrl: env.PUBLIC_URL || 'http://localhost:5173',
  // Set FORCE_HTTPS=true only when the app is served behind HTTPS (enables HSTS and upgrade-insecure-requests).
  // Left off by default so phones can test over plain http on the local network.
  forceHttps: env.FORCE_HTTPS === 'true',
};

// Sessions are server-side (table `sessions`), so no signing secret is needed.
