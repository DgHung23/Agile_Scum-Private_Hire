# PrivateHire Cars - online booking system

Web application (desktop and mobile browsers) with a REST API and PostgreSQL database, built for the COMP1807 Agile
Scrum coursework. The API (`/api/v1`) is designed so a mobile app can reuse it later.

- **Customers:** register, book, pay, receive confirmations, print receipts, cancel or amend, review journeys, redeem offers.
- **Call-centre staff:** verify callers, create accounts, book for phone and walk-in customers, manage cabs and drivers,
  dispatch, answer enquiries, send offers.
- **Manager (admin):** popular-car and loyal-customer reports.

Payments (VISA Check, PayPal), email, SMS and GPS are **simulated** behind service modules; see
[docs/SPRINTS.md](docs/SPRINTS.md) for assumptions and the sprint plan.

## Quick start

Requirements: Node 20+, Docker.

```bash
docker compose up -d db            # PostgreSQL 16 on localhost:5433
cd server && npm install && npm run migrate && npm run seed
npm run dev                        # API on http://localhost:4000
# second terminal
cd web && npm install && npm run dev   # Web on http://localhost:5173
```

Or run everything in one container: `docker compose --profile full up --build` then open http://localhost:4000.

## Repository layout

```
server/   Express API, SQL migrations (db/migrations), seed data, tests
web/      React + Vite single-page app (responsive)
docs/     Sprint plan, user stories, design references
```

## Tech

Node 22 + Express 5, PostgreSQL 16 (`pg`), JWT + bcrypt, zod validation, React 18 + React Router, plain CSS design
system (black/white pill language from the Uber reference, soft cards and calm forms from the Airbnb reference).
