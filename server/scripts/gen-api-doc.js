// Writes docs/API.md from the routers themselves, so the reference never drifts from the code.
// Run: npm run docs:api   (Definition of Done line 5: README and API documentation are updated)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'development';
const { createApp } = await import('../src/app.js');
const { listEndpoints } = await import('../src/routes/index.js');
const { pool } = await import('../src/db.js');
createApp();

const WHO = [
  [/^\/api\/v1\/admin\//, 'Admin'],
  [/^\/api\/v1\/driver\//, 'Driver'],
  [/^\/api\/v1\/staff\/(pricing|offers|reports|customers-loyalty|companies|complaints\/:id\/driver-action)/, 'Manager'],
  [/^\/api\/v1\/staff\/(cabs|drivers)(\/:id)?(\/status|\/documents)?$/, 'Staff (read) / Manager (change)'],
  [/^\/api\/v1\/staff\//, 'Call Centre Staff, Manager'],
  [/^\/api\/v1\/(catalog|track)\//, 'Public'],
  [/^\/api\/v1\/auth\/(register|login|staff-login|forgot|reset|verify-email|unlock|session|logout)$/, 'Public'],
  [/^\/api\/v1\/bookings\/quote$/, 'Public (fare estimate, N13)'],
  [/^\/api\/v1\/(auth\/(me|change-password)|notifications)/, 'Any signed-in user'],
  [/^\/api\/v1\/(enquiries|support\/lost-items)$/, 'Public or customer'],
  [/./, 'Signed-in customer'],
];
const who = (m, p) => (m === 'GET' && /\/staff\/(cabs|drivers)$/.test(p) ? 'Call Centre Staff, Manager' : WHO.find(([re]) => re.test(p))[1]);

const groups = new Map();
for (const [m, p] of listEndpoints()) {
  const key = p.split('/')[3];
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push([m, p]);
}

let md = `# REST API (v1)

Generated from the code by \`npm run docs:api\` (${new Date().toISOString().slice(0, 10)}). In development the same list is served
at \`/api/docs\`; it is not served in production (Definition of Done line 12).

Base URL \`/api/v1\`. JSON in and out. A native mobile app can use exactly these endpoints.

## Sessions (ID-13)

- The web app signs in with \`POST /auth/login\` (customers) or \`POST /auth/staff-login\` (staff, managers, admins,
  drivers). The server sets an **HttpOnly, SameSite=Lax cookie** \`ph_sid\`; JavaScript never sees the session id.
  Requests that change data with the cookie must carry the header \`X-PH-Client: web\` (CSRF guard).
- Apps send \`X-Client: app\` when signing in and receive \`{ token }\`; they then send \`Authorization: Bearer <token>\`.
- A session ends after 30 minutes without activity (\`401 session_expired\`), after 12 hours, or at logout.
- 5 failed logins from one IP address for one account lock that pair for 15 minutes (\`429 account_locked\`); the owner
  is emailed an unlock link.

## Errors

\`\`\`json
{ "error": { "code": "validation_error", "message": "Please check the highlighted fields",
             "fields": { "email": "Enter a valid email address" } } }
\`\`\`

Common codes: \`validation_error\` 400, \`unauthorized\` / \`session_expired\` 401, \`payment_declined\` /
\`sca_wrong_code\` / \`credit_limit\` 402, \`forbidden\` / \`email_not_verified\` / \`not_verified\` / \`over_refund_limit\` 403,
\`not_found\` 404, \`no_availability\` / \`too_late\` / \`bad_status\` / \`hold_expired\` 409, \`account_locked\` /
\`send_limit\` 429. \`no_availability\` also returns \`alternatives: { sizes, times }\` (ID-50).

## Online checkout (ID-53 to ID-57)

1. \`POST /bookings\` with \`acceptTerms: true\` and \`payment\`. The booking is saved as \`pending_payment\` and holds the
   cab for 15 minutes.
2. \`201\` means done (cash to the driver, company account). \`202\` returns \`nextAction\`:
   - \`{ type: "3ds", challengeId, bookingId }\`: confirm with \`POST /bookings/:id/3ds { challengeId, code }\`
     (test code \`123456\`).
   - \`{ type: "redirect", provider, token, bookingId }\`: approve on the provider page
     (\`/payments/redirect/:token/approve\`), then \`POST /bookings/:id/redirect-complete { token }\`.
3. A declined card keeps the booking waiting: retry with \`POST /bookings/:id/pay\`, or give up with
   \`POST /bookings/:id/abandon\`.

## Endpoints
`;
for (const [g, rows] of groups) {
  md += `\n### /${g}\n\n| Method | Path | Who |\n|---|---|---|\n`;
  for (const [m, p] of rows) md += `| ${m} | \`${p.replace('/api/v1', '')}\` | ${who(m, p)} |\n`;
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'API.md');
fs.writeFileSync(out, md);
console.log(`[docs] wrote ${listEndpoints().length} endpoints to docs/API.md`);
await pool.end();
