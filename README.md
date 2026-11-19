# PrivateHire Cars - online booking system

A responsive web application (desktop and phone browsers) with a REST API and a PostgreSQL database, built for the
COMP1807 Agile Scrum coursework. The API (`/api/v1`, JSON, bearer tokens) is designed so a native mobile app can reuse it
without changes.

| Who | What they can do |
|---|---|
| **Customer** | Register, log in, book a minicab online (15% off, priority), pay by card or PayPal, print a receipt, cancel or amend up to 24 hours before pickup, get email/text updates, review journeys, use offer codes, send enquiries |
| **Call-centre staff** | Find and verify callers, create accounts for new callers, book for phone and walk-in customers, see availability and prices, manage cabs and drivers, dispatch, answer enquiries, send offers |
| **Manager (admin)** | Everything staff can do, plus reports on popular cars and sizes and loyal customers |

Payments (VISA Check, PayPal), email, SMS and GPS are **simulated** behind service modules - see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Sent emails and texts appear in the app (Messages / staff Outbox).

## Quick start

Requirements: Node 20+ and Docker.

```bash
docker compose up -d db                 # PostgreSQL 16 on localhost:5433
cd server && npm install
npm run db:demo                         # create tables + demo data (customers, history, reviews, upcoming jobs)
npm run dev                             # API on http://localhost:4000
```

```bash
cd web && npm install && npm run dev    # web app on http://localhost:5173 (proxies /api to :4000)
```

Everything in one container (API serves the built web app): `docker compose --profile full up --build`, then open
http://localhost:4000.

Useful scripts (in `server/`): `npm run migrate` (apply new migrations), `npm run seed` (accounts + fleet only),
`npm run seed:demo`, `npm run db:reset`, `npm run db:demo`, `npm test`.

## Demo accounts

| Role | Email | Password | Sign in at |
|---|---|---|---|
| Customer | customer@privatehire.test | Customer123! | `/login` |
| Call-centre staff | staff@privatehire.test | Staff123! | `/staff/login` |
| Manager | admin@privatehire.test | Admin123! | `/staff/login` |

Other demo customers (same password `Customer123!`): priya.shah@, tom.becker@, grace.liu@, omar.haddad@,
hannah.moore@, luca.romano@ `example.com`.

**Test cards:** Visa `4242 4242 4242 4242`, Mastercard `5555 5555 5555 4444`, Amex `3782 822463 10005` (any future expiry,
any 3-digit code, 4 for Amex). Declined: `4000 0000 0000 0002`; no funds: `4000 0000 0000 9995`. PayPal: any email/password.

**Verifying a caller (call desk):** for Alex Morgan use postcode `SW1A 2AA`, last 4 phone digits `0123`, house number `10`.

## Repository layout

```
server/   Express API, SQL migrations (db/migrations), seed data, 97 automated tests
web/      React + Vite single-page app, plain-CSS design system
docs/     SPRINTS.md (sprint plan + delivery log), TRACEABILITY.md (story -> code -> test), API.md, ARCHITECTURE.md,
          reference/ (user stories, design references)
```

## Tech

Node 22, Express 5, PostgreSQL 16 (`pg`), zod validation, bcrypt + JWT, React 18 + React Router 7, Vite. Design system:
black/white pill language from the Uber reference, soft cards and calm forms from the Airbnb reference.

## How it was built

Three Scrum sprints, ten modules, each developed on its own branch and merged to `main` with a merge commit (see
`git log --graph`). Tags `sprint-1`, `sprint-2`, `sprint-3` mark each potentially shippable increment. Sprint goals,
Definition of Done, assumptions and the delivery log are in [docs/SPRINTS.md](docs/SPRINTS.md).
