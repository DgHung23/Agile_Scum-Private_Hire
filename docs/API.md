# REST API (v1)

Generated from the code by `npm run docs:api` (2026-11-19). In development the same list is served
at `/api/docs`; it is not served in production (Definition of Done line 12).

Base URL `/api/v1`. JSON in and out. A native mobile app can use exactly these endpoints.

## Sessions (ID-13)

- The web app signs in with `POST /auth/login` (customers) or `POST /auth/staff-login` (staff, managers, admins,
  drivers). The server sets an **HttpOnly, SameSite=Lax cookie** `ph_sid`; JavaScript never sees the session id.
  Requests that change data with the cookie must carry the header `X-PH-Client: web` (CSRF guard).
- Apps send `X-Client: app` when signing in and receive `{ token }`; they then send `Authorization: Bearer <token>`.
- A session ends after 30 minutes without activity (`401 session_expired`), after 12 hours, or at logout.
- 5 failed logins from one IP address for one account lock that pair for 15 minutes (`429 account_locked`); the owner
  is emailed an unlock link.

## Errors

```json
{ "error": { "code": "validation_error", "message": "Please check the highlighted fields",
             "fields": { "email": "Enter a valid email address" } } }
```

Common codes: `validation_error` 400, `unauthorized` / `session_expired` 401, `payment_declined` /
`sca_wrong_code` / `credit_limit` 402, `forbidden` / `email_not_verified` / `not_verified` / `over_refund_limit` 403,
`not_found` 404, `no_availability` / `too_late` / `bad_status` / `hold_expired` 409, `account_locked` /
`send_limit` 429. `no_availability` also returns `alternatives: { sizes, times }` (ID-50).

## Online checkout (ID-53 to ID-57)

1. `POST /bookings` with `acceptTerms: true` and `payment`. The booking is saved as `pending_payment` and holds the
   cab for 15 minutes.
2. `201` means done (cash to the driver, company account). `202` returns `nextAction`:
   - `{ type: "3ds", challengeId, bookingId }`: confirm with `POST /bookings/:id/3ds { challengeId, code }`
     (test code `123456`).
   - `{ type: "redirect", provider, token, bookingId }`: approve on the provider page
     (`/payments/redirect/:token/approve`), then `POST /bookings/:id/redirect-complete { token }`.
3. A declined card keeps the booking waiting: retry with `POST /bookings/:id/pay`, or give up with
   `POST /bookings/:id/abandon`.

## Endpoints

### /admin

| Method | Path | Who |
|---|---|---|
| GET | `/admin/audit` | Admin |
| POST | `/admin/jobs/:name` | Admin |
| GET | `/admin/settings` | Admin |
| PUT | `/admin/settings` | Admin |
| GET | `/admin/staff` | Admin |
| POST | `/admin/staff` | Admin |
| PATCH | `/admin/staff/:id` | Admin |

### /auth

| Method | Path | Who |
|---|---|---|
| POST | `/auth/change-password` | Any signed-in user |
| POST | `/auth/forgot` | Public |
| POST | `/auth/login` | Public |
| POST | `/auth/logout` | Public |
| GET | `/auth/me` | Any signed-in user |
| PATCH | `/auth/me` | Any signed-in user |
| PUT | `/auth/me/secret-word` | Any signed-in user |
| POST | `/auth/register` | Public |
| POST | `/auth/reset` | Public |
| GET | `/auth/session` | Public |
| POST | `/auth/staff-login` | Public |
| POST | `/auth/unlock` | Public |
| POST | `/auth/verify-email` | Public |
| POST | `/auth/verify-email/resend` | Signed-in customer |

### /bookings

| Method | Path | Who |
|---|---|---|
| GET | `/bookings/` | Signed-in customer |
| POST | `/bookings/` | Signed-in customer |
| GET | `/bookings/:id` | Signed-in customer |
| POST | `/bookings/:id/3ds` | Signed-in customer |
| POST | `/bookings/:id/abandon` | Signed-in customer |
| POST | `/bookings/:id/amend` | Signed-in customer |
| POST | `/bookings/:id/amend/preview` | Signed-in customer |
| POST | `/bookings/:id/cancel` | Signed-in customer |
| POST | `/bookings/:id/incident` | Signed-in customer |
| POST | `/bookings/:id/pay` | Signed-in customer |
| GET | `/bookings/:id/receipt` | Signed-in customer |
| POST | `/bookings/:id/redirect-complete` | Signed-in customer |
| POST | `/bookings/:id/review` | Signed-in customer |
| DELETE | `/bookings/:id/share` | Signed-in customer |
| POST | `/bookings/:id/share` | Signed-in customer |
| POST | `/bookings/quote` | Public (fare estimate, N13) |

### /business

| Method | Path | Who |
|---|---|---|
| POST | `/business/apply` | Signed-in customer |
| GET | `/business/bookings` | Signed-in customer |
| POST | `/business/invoices/:id/pay` | Signed-in customer |
| POST | `/business/join` | Signed-in customer |
| GET | `/business/me` | Signed-in customer |
| DELETE | `/business/members/:id` | Signed-in customer |
| POST | `/business/members/invite` | Signed-in customer |

### /catalog

| Method | Path | Who |
|---|---|---|
| GET | `/catalog/cab-sizes` | Public |
| GET | `/catalog/locations` | Public |
| GET | `/catalog/packages` | Public |
| GET | `/catalog/services` | Public |
| GET | `/catalog/settings` | Public |

### /driver

| Method | Path | Who |
|---|---|---|
| GET | `/driver/jobs` | Driver |
| POST | `/driver/jobs/:id/late` | Driver |
| POST | `/driver/jobs/:id/report` | Driver |
| POST | `/driver/jobs/:id/status` | Driver |

### /enquiries

| Method | Path | Who |
|---|---|---|
| POST | `/enquiries/` | Signed-in customer |
| GET | `/enquiries/mine` | Signed-in customer |

### /notifications

| Method | Path | Who |
|---|---|---|
| GET | `/notifications/` | Any signed-in user |

### /offers

| Method | Path | Who |
|---|---|---|
| GET | `/offers/mine` | Signed-in customer |
| POST | `/offers/validate` | Signed-in customer |

### /payments

| Method | Path | Who |
|---|---|---|
| GET | `/payments/cards` | Signed-in customer |
| POST | `/payments/cards` | Signed-in customer |
| DELETE | `/payments/cards/:id` | Signed-in customer |
| GET | `/payments/redirect/:token` | Signed-in customer |
| POST | `/payments/redirect/:token/approve` | Signed-in customer |
| POST | `/payments/redirect/:token/cancel` | Signed-in customer |

### /receipts

| Method | Path | Who |
|---|---|---|
| GET | `/receipts/` | Signed-in customer |
| GET | `/receipts/:id` | Signed-in customer |
| GET | `/receipts/:id/pdf` | Signed-in customer |
| POST | `/receipts/:id/send` | Signed-in customer |

### /staff

| Method | Path | Who |
|---|---|---|
| GET | `/staff/availability` | Call Centre Staff, Manager |
| GET | `/staff/bookings` | Call Centre Staff, Manager |
| POST | `/staff/bookings` | Call Centre Staff, Manager |
| GET | `/staff/bookings/:id` | Call Centre Staff, Manager |
| GET | `/staff/bookings/:id/alternatives` | Call Centre Staff, Manager |
| POST | `/staff/bookings/:id/amend` | Call Centre Staff, Manager |
| POST | `/staff/bookings/:id/assign` | Call Centre Staff, Manager |
| POST | `/staff/bookings/:id/cancel` | Call Centre Staff, Manager |
| POST | `/staff/bookings/:id/charge` | Call Centre Staff, Manager |
| POST | `/staff/bookings/:id/company-cancel` | Call Centre Staff, Manager |
| POST | `/staff/bookings/:id/destination` | Call Centre Staff, Manager |
| GET | `/staff/bookings/:id/history` | Call Centre Staff, Manager |
| POST | `/staff/bookings/:id/late` | Call Centre Staff, Manager |
| GET | `/staff/bookings/:id/options` | Call Centre Staff, Manager |
| POST | `/staff/bookings/:id/refund` | Call Centre Staff, Manager |
| POST | `/staff/bookings/:id/status` | Call Centre Staff, Manager |
| POST | `/staff/bookings/:id/unassign` | Call Centre Staff, Manager |
| GET | `/staff/cabs` | Call Centre Staff, Manager |
| POST | `/staff/cabs` | Staff (read) / Manager (change) |
| PATCH | `/staff/cabs/:id` | Staff (read) / Manager (change) |
| PUT | `/staff/cabs/:id/documents` | Staff (read) / Manager (change) |
| PATCH | `/staff/cabs/:id/status` | Staff (read) / Manager (change) |
| GET | `/staff/companies` | Manager |
| POST | `/staff/companies/:id/approve` | Manager |
| POST | `/staff/companies/:id/invoice` | Manager |
| POST | `/staff/companies/:id/reject` | Manager |
| POST | `/staff/companies/:id/status` | Manager |
| POST | `/staff/companies/billing-check` | Manager |
| GET | `/staff/complaints` | Call Centre Staff, Manager |
| POST | `/staff/complaints/:id/answer` | Call Centre Staff, Manager |
| POST | `/staff/complaints/:id/driver-action` | Manager |
| POST | `/staff/customers` | Call Centre Staff, Manager |
| GET | `/staff/customers-loyalty` | Manager |
| GET | `/staff/customers/:id` | Call Centre Staff, Manager |
| POST | `/staff/customers/:id/email` | Call Centre Staff, Manager |
| GET | `/staff/customers/:id/notes` | Call Centre Staff, Manager |
| POST | `/staff/customers/:id/notes` | Call Centre Staff, Manager |
| GET | `/staff/customers/:id/receipts` | Call Centre Staff, Manager |
| POST | `/staff/customers/:id/verify` | Call Centre Staff, Manager |
| GET | `/staff/customers/search` | Call Centre Staff, Manager |
| GET | `/staff/dashboard` | Call Centre Staff, Manager |
| GET | `/staff/dispatch` | Call Centre Staff, Manager |
| GET | `/staff/documents/expiring` | Call Centre Staff, Manager |
| GET | `/staff/drivers` | Call Centre Staff, Manager |
| POST | `/staff/drivers` | Staff (read) / Manager (change) |
| PATCH | `/staff/drivers/:id` | Staff (read) / Manager (change) |
| PUT | `/staff/drivers/:id/documents` | Staff (read) / Manager (change) |
| GET | `/staff/enquiries` | Call Centre Staff, Manager |
| POST | `/staff/enquiries/:id/reply` | Call Centre Staff, Manager |
| GET | `/staff/incidents` | Call Centre Staff, Manager |
| POST | `/staff/incidents/:id/handle` | Call Centre Staff, Manager |
| GET | `/staff/lost-items` | Call Centre Staff, Manager |
| POST | `/staff/lost-items` | Call Centre Staff, Manager |
| PATCH | `/staff/lost-items/:id` | Call Centre Staff, Manager |
| GET | `/staff/offers` | Manager |
| POST | `/staff/offers` | Manager |
| POST | `/staff/offers/:id/deactivate` | Manager |
| POST | `/staff/offers/recommend` | Manager |
| GET | `/staff/pricing` | Manager |
| PUT | `/staff/pricing` | Manager |
| GET | `/staff/receipts/:id` | Call Centre Staff, Manager |
| GET | `/staff/receipts/:id/pdf` | Call Centre Staff, Manager |
| POST | `/staff/receipts/:id/send` | Call Centre Staff, Manager |
| GET | `/staff/reports/popular` | Manager |
| GET | `/staff/reviews` | Call Centre Staff, Manager |
| POST | `/staff/reviews/:id/hide` | Call Centre Staff, Manager |
| GET | `/staff/reviews/summary` | Call Centre Staff, Manager |

### /support

| Method | Path | Who |
|---|---|---|
| GET | `/support/complaints` | Signed-in customer |
| POST | `/support/complaints` | Signed-in customer |
| POST | `/support/delete-account` | Signed-in customer |
| GET | `/support/favourites` | Signed-in customer |
| POST | `/support/favourites` | Signed-in customer |
| DELETE | `/support/favourites/:id` | Signed-in customer |
| GET | `/support/lost-items` | Public or customer |
| POST | `/support/lost-items` | Public or customer |
| GET | `/support/my-data` | Signed-in customer |

### /track

| Method | Path | Who |
|---|---|---|
| GET | `/track/:token` | Public |
