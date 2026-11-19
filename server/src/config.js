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
  // Email delivery (ID-44): set SMTP_HOST to send through an SMTP server (Mailpit in docker-compose); empty = simulated.
  smtpHost: env.SMTP_HOST || '',
  smtpPort: Number(env.SMTP_PORT || 1025),
  mailFrom: env.MAIL_FROM || 'Private Hire Cars <bookings@privatehire.example>',
};

// Sessions are server-side (table `sessions`), so no signing secret is needed.
