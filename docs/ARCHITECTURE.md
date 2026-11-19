# Architecture and decisions

```
Browser (React SPA)  --JSON/HTTPS-->  Express API  --SQL-->  PostgreSQL 16
   desktop + phone                      /api/v1
   (future: mobile app uses the same API)
```

## Database (8 migrations, one per delivered module)

| Migration | Tables |
|---|---|
| 001 core | `settings` (discount %, cancel window), `users` (customer / staff / admin) |
| 002 accounts | `notifications` (simulated email/SMS outbox) |
| 003 fleet | `cab_sizes`, `services`, `cabs`, `drivers`, `locations`, **`bookings`** |
| 004 payments | `saved_cards`, `payments`, `paypal_sessions`, `bookings.payment_status` |
| 005 amend | `bookings.offer_pct`, `amended_at`, `amend_count` |
| 006 call centre | `caller_verifications` (audit of every verification attempt) |
| 007 enquiries | `enquiries`, `enquiry_replies` |
| 008 reviews and loyalty | `reviews`, `offers`, `offer_recipients`, `offer_redemptions`, `password_resets` |

## Decisions worth explaining in the report

1. **Double booking is impossible, not just unlikely.** `bookings` has two `EXCLUDE USING gist` constraints
   (`cab_id` and `driver_id` with `tstzrange(pickup_at, end_at)`), so the database rejects overlapping jobs whatever the
   application does. Concurrent bookings of the same cab size also take a Postgres advisory lock so they queue instead of
   deadlocking (found by a 6-parallel-request test). `end_at` includes a 20 minute turnaround buffer.
2. **Payment and booking are one transaction.** A declined card throws inside the transaction, so no booking row and no
   reserved cab are left behind; the declined attempt is audited separately.
3. **The server prices everything.** The browser shows quotes, but `createBooking` recomputes the price, discount and
   availability. The 15% discount only applies to `channel = 'online'`; staff cannot book on that channel.
4. **Card data is never stored.** Only brand, last 4, expiry and an opaque token. CVV is validated and discarded.
5. **Verification is enforced by the API, not the screen.** Customer details, staff bookings and emails for a customer
   require a verification by that staff member in the last 30 minutes (two matching answers plus an explicit
   "identity verified" confirmation, locked after 5 failures).
6. **Business rules are data.** Discount % and the 24 hour window live in `settings`; services, cab sizes and rates are
   tables, so the Product Owner can change them without a deployment.
7. **Security basics:** bcrypt, JWT, parameterised SQL everywhere, zod validation on every body/query, helmet + CSP,
   generic login errors with constant-time comparison, single-use expiring reset tokens (stored hashed), rate limiting
   on auth in production, ownership checks that return 404 for other people's data.

## Simulated integrations (replace behind the same functions)

| Integration | Module | To go live |
|---|---|---|
| Email / SMS | `services/notify.js` (`sendEmail`, `sendSms`) | call SendGrid / Twilio, keep the insert as an audit trail |
| VISA Check / card gateway | `services/payments.js` (`visaCheck`, `takePayment`) | call the bank / PSP, store its token |
| PayPal | `routes/payments.js` + `PayPalMock.jsx` | replace with PayPal Orders API and a return URL |
| Distance / ETA | `services/pricing.js` (`estimateDistance`) | call a routing API (known London places already use great-circle x 1.15) |
| GPS despatch | `routes/dispatch.js` (ETA entered by staff) | feed ETA from the GPS system into the same endpoint |

## Known limitations (honest list for the retrospective)

- Free-text addresses use a deterministic distance estimate, not real routing.
- One cab per booking; a booking cannot span several cars.
- Staff accounts are seeded; there is no staff management screen.
- Offer codes are percentage-only and single use per customer.
- Emails are plain text.
