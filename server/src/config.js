import 'dotenv/config';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

export const config = {
  env: env.NODE_ENV || 'development',
  isProd,
  port: Number(env.PORT || 4000),
  databaseUrl:
    env.DATABASE_URL || 'postgres://privatehire:privatehire_dev@localhost:5433/privatehire',
  jwtSecret: env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',
  corsOrigin: env.CORS_ORIGIN || 'http://localhost:5173',
  publicUrl: env.PUBLIC_URL || 'http://localhost:5173',
};

if (isProd && config.jwtSecret === 'dev-only-secret-change-me') {
  console.warn('[config] JWT_SECRET is not set - set a strong secret in production.');
}
