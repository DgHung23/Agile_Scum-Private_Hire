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

_Updated at the end of each module._
