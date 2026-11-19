# REST API (v1)

Base URL `/api/v1`. JSON in and out. Authenticated calls send `Authorization: Bearer <token>` (from `/auth/login` or
`/auth/staff-login`). A native mobile app can use exactly these endpoints.

**Errors** always look like:

```json
{ "error": { "code": "validation_error", "message": "Please check the highlighted fields",
             "fields": { "email": "Enter a valid email address" } } }
```

Common codes: `validation_error` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `email_taken` / `no_availability`
/ `too_late` / `not_modifiable` 409, `payment_declined` 402 (booking rolled back), `locked` / `rate_limited` 429.
`no_availability` also returns `alternatives: { sizes: [...], times: [...] }`.

Roles: **public**, **customer**, **staff** (call centre), **admin** (manager; also staff).

## Auth and account

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/auth/register` | public | Create account, sends confirmation email |
| POST | `/auth/login` | public | Customer login -> `{ token, user }` |
| POST | `/auth/staff-login` | public | Staff / manager login |
| GET, PATCH | `/auth/me` | any | Read / update profile |
| POST | `/auth/change-password` | any | Change password |
| POST | `/auth/forgot`, `/auth/reset` | public | Email a reset link / set a new password (single use, 1 hour) |
| GET | `/notifications?scope=mine\|all` | any / staff | Simulated inbox (emails and texts) |

## Catalog

| GET | `/catalog/services`, `/catalog/cab-sizes`, `/catalog/locations?q=`, `/catalog/settings` | public |
|---|---|---|

## Booking (customer)

| Method | Path | Purpose |
|---|---|---|
| POST | `/bookings/quote` | Price every cab size + availability (public; optional `offerCode` when logged in) |
| POST | `/bookings` | Create booking with `payment` (`card` / `saved card` / `paypal`), `notifyPref`, `offerCode` |
| GET | `/bookings?when=upcoming\|past\|all`, `/bookings/:id` | My bookings, detail with payments and review |
| GET | `/bookings/:id/receipt` | Receipt data |
| POST | `/bookings/:id/cancel` | Cancel (24h rule) and refund |
| POST | `/bookings/:id/amend/preview`, `/bookings/:id/amend` | Check / apply changes with price difference |
| POST | `/bookings/:id/review` | Rate journey, cab, driver (completed trips only) |
| GET, POST, DELETE | `/payments/cards[/:id]` | Saved cards (masked) |
| POST | `/payments/paypal/start`, `/payments/paypal/:token/approve\|cancel` | Simulated PayPal |
| GET, POST | `/offers/mine`, `/offers/validate` | My offers / check a code |
| POST, GET | `/enquiries`, `/enquiries/mine` | Send enquiry (public; trip enquiry needs login) |

## Staff (`/staff/...`)

| Area | Endpoints |
|---|---|
| Fleet | `GET/POST /cabs`, `PATCH /cabs/:id`, `GET/POST /drivers`, `PATCH /drivers/:id`, `GET /availability` |
| Call desk | `GET /customers/search`, `POST /customers/:id/verify`, `GET /customers/:id` (verified only), `POST /customers` (new caller), `POST /customers/:id/email` |
| Bookings | `POST /bookings` (phone / in person), `GET /bookings`, `GET /bookings/:id`, `POST /bookings/:id/cancel`, `/amend` |
| Dispatch | `GET /dispatch`, `GET /bookings/:id/options`, `POST /bookings/:id/assign`, `/unassign`, `/status`, `GET /dashboard` |
| Enquiries | `GET /enquiries`, `POST /enquiries/:id/reply` |
| Reviews | `GET /reviews`, `GET /reviews/summary` |
| Offers | `GET/POST /offers`, `POST /offers/recommend`, `POST /offers/:id/deactivate`, `GET /customers-loyalty` |
| Reports (admin) | `GET /reports/popular?days=` |
