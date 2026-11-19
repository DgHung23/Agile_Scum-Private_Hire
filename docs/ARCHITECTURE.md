# Architecture and decisions

```
Browser (React SPA)  --JSON, HttpOnly session cookie-->  Express API  --SQL-->  PostgreSQL 16
   desktop + phone                                         /api/v1          |
   (future: mobile app uses the same API with a bearer token)                +--> SMTP (Mailpit test inbox, optional)
                                                          background jobs: holds, delivery, reminders, invoices, retention
```

## Database (14 migrations)

| Migration | Tables (report ERD figure) |
|---|---|
| 001 core | `settings`, `users` (USER + CUSTOMER_PROFILE + STAFF_MEMBER in one table, F1) |
| 002 accounts | `notifications` (NOTIFICATION, F1) |
| 003 fleet | `cab_sizes`, `services` (SERVICE_TYPE, F2), `cabs`, `drivers` (F7), `locations`, `bookings` (BOOKING, F2) |
| 004 payments | `saved_cards`, `payments` (PAYMENT and REFUND, F3) |
| 005 amend | amendment columns on `bookings` |
| 006 call centre | `caller_verifications` |
| 007 enquiries | `enquiries`, `enquiry_replies` (ENQUIRY, F6) |
| 008 reviews and loyalty | `reviews` (REVIEW, F4), `password_resets` |
| 009 accounts (V1) | eight roles, `sessions`, `login_attempts`, `email_tokens`, `audit_log` (AUDIT_LOG, F1), `customer_notes` |
| 010 booking (V2) | booking states (Figure 25), booking options, `hire_packages`, `coupons` / `customer_coupons` / `coupon_redemptions` (COUPON, CUSTOMER_COUPON, F3), `applied_discounts` (APPLIED_DISCOUNT, F3), `sca_challenges`, `redirect_sessions` |
| 011 receipts (V3) | `receipts` (receipts and credit notes), `receipt_sends`, delivery columns on `notifications`, `trip_shares`, `incidents` |
| 012 fleet (V4) | `documents` (DOCUMENT, F7), `assignments` (ASSIGNMENT, F7), `status_events` (STATUS_EVENT, F2), driver logins |
| 013 support (V5) | `lost_items` (LOST_ITEM, F6), `complaints` (COMPLAINT, F6), `favourite_places`, `data_requests` |
| 014 business (V6) | `companies` (COMPANY, F6), `company_members` (COMPANY_MEMBER, F6), `company_invites`, `invoices`, `invoice_lines` (F4) |

## Decisions worth explaining in the report

1. **Double booking is impossible, not just unlikely (ID-49).** `bookings` has two `EXCLUDE USING gist` constraints
   (cab and driver with `tstzrange(pickup_at, end_at)`) over every state except cancelled, company cancelled and
   abandoned. Bookings of the same cab size queue on a Postgres advisory lock. A booking waiting for payment holds its
   cab for 15 minutes, then a job releases it.
2. **Payment follows the report's sequence diagram (Figure 26).** The booking is saved as Pending payment, then the card
   goes through a 3D Secure check and the bank. A declined card never confirms a booking; the customer retries with the
   journey kept. Phone payments are taken at once (outside 3D Secure, like a real telephone order).
3. **The server prices everything (ID-51).** Fare + service fee + surcharges (night, zone, weather), then the 15%
   programme discount, then one fixed-amount coupon, never below £5 (report Table 17). The breakdown is stored on the
   booking and in `applied_discounts`.
4. **Sessions are server-side (ID-13).** The browser holds an HttpOnly, SameSite=Lax cookie; only a hash of the id is
   stored; 30 minutes idle ends it; logout and password changes end it on the server. Cookie requests that change data
   need a custom header (CSRF guard). Lockout counts failures per account **and** IP so an attacker cannot lock a victim
   out everywhere, and an emailed link unlocks it.
5. **Roles follow the access matrix (Appendix D).** Manager inherits Call Centre Staff; Admin handles staff accounts,
   settings and the audit log but not bookings. Every rule is checked on the server (403).
6. **Every staff action is audited (Definition of Done line 9).** `audit_log` stores who, what, which record and when for
   bookings, dispatch, refunds, record views (receipts, notes), fleet, prices, settings and jobs; `status_events` and
   `assignments` keep the history of each journey (who dispatched the car, as TfL requires).
7. **Messages never undo an action (ID-44).** Email and text rows are written inside the action's transaction as
   `queued` and delivered after the commit, with 3 attempts; failures show to the customer and on the staff dashboard.
8. **Receipts are immutable (FR-6.8).** A receipt is created once per payment; a refund adds a linked credit note.
   PDFs are rendered on demand.
9. **Caller verification uses data that is not on a receipt (ID-20).** The secret word is required when set; email and
   booking reference never count.
10. **Card data is never stored.** Only brand, last 4, expiry and an opaque token; the CVV is validated and discarded.
11. **Business rules are data.** Discount %, windows, limits, surcharges, packages and prices live in tables the Admin
    or Manager edit (audited), so they change without a deployment.

## Simulated integrations (replace behind the same functions)

| Integration | Module | To go live |
|---|---|---|
| Email | `services/notify.js` | already sends over SMTP when `SMTP_HOST` is set (Mailpit in docker-compose); point it at a real provider |
| SMS | `services/notify.js` (`deliverOnce`) | call Twilio or similar |
| 3D Secure + card bank | `services/checkout.js`, `services/payments.js` (`visaCheck`) | use the PSP's SCA flow and token |
| PayPal / pay by bank | `routes/payments.js` redirect sessions + `pages/PayPalMock.jsx` | PayPal Orders API / Open Banking provider |
| Distance / ETA | `services/pricing.js` (`estimateDistance`) | routing API |
| GPS despatch | staff and Driver view enter ETA and status | feed the GPS system into the same endpoints |
| Company credit check | Manager approval screen | credit reference agency |

## Known limitations (honest list for the retrospective)

- ID-27 chat with support is not built (Could); ID-64's "pay the difference within 24 hours or undo" path is not built.
- Free-text addresses use a deterministic distance estimate, not real routing; there is no live map.
- One cab per booking; groups of more than 8 need two bookings.
- Driver photos are a URL field; there is no upload.
- Emails are plain text with attachments; there are no HTML templates.
