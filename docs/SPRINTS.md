# Sprint plan and delivery log

Team practice: every **module** is developed on its own branch (`sprint-N/module-name`), merged into `main` with `--no-ff`
(so the merge commit marks the module delivery) and pushed. Each sprint ends with a tag (`sprint-1`, `sprint-2`,
`sprint-3`) = the *potentially shippable increment*.

Story IDs come from [reference/user-stories.md](reference/user-stories.md) (R# = Product Owner requirement).

## Definition of Done (all sprints)

1. Acceptance criteria of every story in the module are met and were checked by running the app.
2. API validates input server-side (never trusts the browser); errors return `{error:{code,message,fields}}`.
3. Works at desktop (1366px) and phone (390px) widths with no horizontal scroll; keyboard focus visible.
4. Database change shipped as a numbered SQL migration; seed data updated.
5. Automated tests for the business rules in the module pass (`npm test` in `server/`).
6. Merged to `main` and pushed with a descriptive commit.

## Sprint 1 - Foundation, accounts and fleet

**Sprint goal:** a customer can register and log in, staff can log in, and staff can manage the fleet that availability
checks will depend on.

| Module | Branch | Stories | Notes |
|---|---|---|---|
| M1 Platform and design system | `sprint-1/platform` | (enabler) | Docker Postgres, migrations, Express API skeleton, React shell, responsive design system (Uber/Airbnb references) |
| M2 Accounts and authentication | `sprint-1/accounts` | US1.1, US1.2, US1.3, US1.5, US9.1 | bcrypt, JWT, roles, confirmation email via the email outbox |
| M3 Fleet, drivers and availability | `sprint-1/fleet` | US9.6, US9.7, US5.1 (engine), US9.4 (data) | DB exclusion constraint prevents double-booking |

## Sprint 2 - Booking, payment and receipts (MVP journey)

**Sprint goal:** a registered customer can book a minicab online, get the 15% discount, pay, print a receipt, and cancel or
amend within the 24-hour rule.

| Module | Branch | Stories |
|---|---|---|
| M4 Booking wizard and pricing | `sprint-2/booking` | US3.1-3.7, US4.1, US5.2 |
| M5 Payments, receipts, saved cards | `sprint-2/payments` | US5.3, US5.4, US6.1, US4.2, US1.4 |
| M6 Cancel and amend | `sprint-2/cancel-amend` | US8.1, US8.2 |

## Sprint 3 - Call centre, communication, loyalty and hardening

**Sprint goal:** call-centre staff can serve phone customers end to end, customers can talk to the company and review
journeys, and the business can reward loyal customers. Release hardening and documentation.

| Module | Branch | Stories |
|---|---|---|
| M7 Call desk | `sprint-3/call-desk` | US9.2, US9.3, US9.5 (+ US9.4 UI) |
| M8 Enquiries, dispatch and notifications | `sprint-3/comms-dispatch` | US2.1-2.3, US9.8, US9.9, US4.3 |
| M9 Reviews and loyalty | `sprint-3/reviews-loyalty` | US7.1, US7.2, US10.1-10.4, US1.6 |
| M10 Hardening and release | `sprint-3/release` | tests, docs, Docker image, a11y/responsive polish |

## Assumptions (open Product Owner questions from the stories file)

| # | Question | Assumption used in the prototype |
|---|---|---|
| 1 | Can payment, email, SMS and GPS be simulated? | Yes. All four are simulated behind service modules (`server/src/services`) so a real provider can replace each one. Sent messages are stored in a notifications outbox that is visible in the app. |
| 2 | Offer code vs 15% online discount | They stack: the 15% is applied first, then the offer percentage on the discounted price. |
| 3 | How is price calculated? | Rate table: service base fare + per-mile rate x distance x cab-size multiplier, minimum fare per service; daily hire is hourly. Distance comes from a London places list (haversine) or an estimate for free-text addresses. |
| 4 | What can be amended? | Date, time, addresses, passengers, hours (daily hire) and cab size. Not the service type. |
| 5 | Does "in person" need its own screen? | No - staff use the same call desk and choose the channel Phone or In person. |

## Delivery log

_Updated at the end of each sprint. Tag = potentially shippable increment._

### Sprint 1 (tag `sprint-1`) - Foundation, accounts and fleet

Increment: a customer can register (confirmation email) and log in; staff sign in separately; staff manage cabs and
drivers; the database refuses to double-book a cab or driver.

| Module | Delivered | Evidence |
|---|---|---|
| M1 Platform | Docker Postgres, migrations, Express API skeleton, React shell, design system | home page verified at 1366px and 390px |
| M2 Accounts | US1.1, 1.2, 1.3, 1.5, 9.1 | 10 API tests, browser e2e (register, login, logout + Back, staff login) |
| M3 Fleet | US9.6, 9.7, 5.1 engine, 9.4 data | 19 API tests (incl. exclusion constraint), browser e2e |

### Sprint 2 (tag `sprint-2`) - Booking, payment and receipts (MVP journey)

Increment: a registered customer books online with the 15% discount, pays by card or PayPal, prints a receipt, and
cancels or amends within the 24-hour rule.

| Module | Delivered | Evidence |
|---|---|---|
| M4 Booking | US3.1-3.7, 4.1, 4.2, 5.1, 5.2 | pricing unit tests, 6 parallel requests never double-book, wizard e2e that survives login |
| M5 Payments | US5.3, 5.4, 6.1, 1.4 | Luhn/expiry/Amex rules tested, decline rolls back booking, card number never stored |
| M6 Cancel/amend | US8.1, 8.2 | 24h boundary tests (23h refused, 25h allowed), refund/charge difference, availability re-check |

Defects found and fixed during the sprint (kept for the retrospective): zod 4 ignoring `required_error`; Express 5
read-only `req.query`; deadlock when parallel bookings hit the exclusion constraint (fixed with a per-size advisory
lock); wizard losing its quote after login; PayPal-cancel message being cleared; logout racing the route guard.

### Sprint 3 (tag `sprint-3`) - Call centre, communication, loyalty and release

Increment: call-centre staff serve phone and walk-in customers end to end (verify, book, dispatch, text the customer),
customers enquire and review, and the business rewards loyal customers. Release hardening and documentation.

| Module | Delivered | Evidence |
|---|---|---|
| M7 Call desk | US9.2, 9.3, 9.5, 9.4 UI | 13 API tests: masked search, 2-answer verification + confirmation, lockout, no online discount for phone bookings |
| M8 Comms and dispatch | US2.1-2.3, 9.8, 9.9, 4.3, 3.7 | 11 API tests: arrival text sent once with reg/colour/make when ETA <= 15, priority-first dispatch, driver clash refused |
| M9 Reviews and loyalty | US7.1, 7.2, 10.1-10.4, 1.6 | 15 API tests: one review per booking, offer single-use and released on cancel, manager-only reports |
| M10 Release | Dockerfile (single container), demo dataset, traceability matrix, API and architecture docs, opt-in HTTPS headers | 97/97 tests, 62-page regression crawl (4 roles x desktop/mobile) with no errors or overflow, container verified in a real browser |

Defects found and fixed during the sprint: a template-literal regex escape that disabled the CVV check in the browser;
HSTS / `upgrade-insecure-requests` would have broken testing from a phone over plain http (now opt-in via `FORCE_HTTPS`);
demo seeder needed savepoints so an overlapping slot does not abort the transaction.

### Sprint retrospective notes (draft for the report)

- **Went well:** each module shipped with automated tests plus a browser run at two widths; the database constraints caught a
  concurrency bug before any user could.
- **Did not go well:** several bugs were test-script races rather than product bugs, which cost time; error-message options
  changed between zod versions and was only noticed in Sprint 2.
- **Improve next time:** add the traceability table at the start of the project, and run the browser regression crawl in CI.

## Backlog v3 alignment (group report, 19 Nov 2026)

The group report (backlog v3: 101 stories in 12 Epics, 8 actors, story keys `ID-xx` and `N01`-`N39`) widened the scope.
This work brings the product in line with it, one module per branch `backlog-v3/<module>`, merged to `main` with `--no-ff`.
Story keys below are the report's Jira keys; `docs/TRACEABILITY.md` maps them to code and tests.

| Module | Branch | Stories | Evidence |
|---|---|---|---|
| V1 Accounts and access | `backlog-v3/accounts-access` | ID-11, ID-12, ID-13, ID-15, ID-17, ID-18, ID-20, N01, N02, N03, N04 | 107 API tests; browser run: register, verify link, HttpOnly cookie, role-based staff portal, admin pages at 1366px and 390px |
