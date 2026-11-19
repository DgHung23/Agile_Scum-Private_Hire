# Traceability: report backlog v3 -> module -> code -> test

Source: the group report (`PrivateHire_Group_Report_v2.docx`, Appendix C, backlog v3: 101 active stories, story keys
`ID-xx` from Jira and `N01`-`N39` new in v3) and `PrivateHire-functional-requirements-v3.md` (FR-1.1 to FR-12.2).
"Module" is the delivery in `docs/SPRINTS.md` (M1-M10 = first build, V1-V6 = backlog v3 alignment). "Test" names the
file in `server/test/` (`<name>.test.js`); "browser" means it was checked in a scripted browser run.

## Product Owner requirements

| R | Requirement (short) | Report stories (Table 10) |
|---|---|---|
| R1 | Register a profile, confirmation email | ID-11, ID-12, ID-14, ID-15, ID-16 |
| R2 | General and trip enquiries | ID-23, ID-24, ID-25 |
| R3 | Online / in person / phone; 15% online | ID-31, ID-35 |
| R4 | Choice of services | ID-28, ID-75 |
| R5 | Log in to book; journey, passengers, cab size | ID-13, ID-29, ID-30, ID-32 |
| R6 | Email or text; text 10-15 min before arrival | ID-32, ID-43, ID-44, ID-45, ID-67, ID-68 |
| R7 | Availability, price, payment, card check, PayPal | ID-36, ID-48, ID-49, ID-51, ID-53, ID-54, ID-55, ID-76 |
| R8 | Printable online receipt | ID-33, ID-59 (+ N37, N38, N39) |
| R9 | Reviews and star ratings | ID-60, ID-61, ID-67, ID-68 |
| R10 | Cancel or amend up to 24 h before | ID-33, ID-62, ID-63, ID-64, ID-77 |
| R11 | Caller verification, open or create account | ID-18, ID-19, ID-20, ID-21 |
| R12 | Staff see cabs, drivers and prices | ID-58, ID-79 |
| R13 | Staff email, reply, create accounts, cabs, drivers, bookings | ID-18, ID-21, ID-25, ID-35, ID-36, ID-65, ID-66, ID-77, ID-79 |
| R14 | Popular cars, loyal customers, offers with codes | ID-69, ID-70, ID-71, ID-72, ID-73 |

## All stories (Appendix C order)

| Key | Our ID | Epic | Story | MoSCoW | Status | Module | Main code | Test |
|---|---|---|---|---|---|---|---|---|
| ID-11 | US1.1 | Accounts and Access | Register an account | Must | Done | V1 | `routes/auth.js` register, verify-email | auth |
| ID-12 | US1.2 | Accounts and Access | Receive a registration confirmation email | Must | Done | V1 | `services/notify.js` welcome + verify | auth |
| ID-13 | US1.3 | Accounts and Access | Log in and log out | Must | Done | V1 | `middleware/auth.js` sessions, lockout in `routes/auth.js` | auth |
| ID-18 | US1.7 | Accounts and Access | Staff log in | Must | Done | V1 | `/auth/staff-login`, role checks | auth |
| ID-19 | US1.8a | Accounts and Access | Find a caller | Must | Done | M7 | `routes/callcentre.js` search | callcentre |
| ID-20 | US1.8b | Accounts and Access | Verify a caller before their details open | Must | Done | V5 | `routes/callcentre.js` verify (secret word) | callcentre |
| ID-21 | US1.9 | Accounts and Access | Create an account for a new caller | Must | Done | M7 | `routes/callcentre.js` new caller | callcentre |
| N01 | new | Accounts and Access | Create staff accounts and give roles | Must | Done | V1 | `routes/admin.js` staff | admin |
| ID-14 | US1.4 | Accounts and Access | Save card details to my profile | Should | Done | M5 | `routes/payments.js` saved cards | payments |
| ID-15 | US1.5a | Accounts and Access | Edit my profile and marketing consent | Should | Done | V1 | `PATCH /auth/me` | auth |
| ID-17 | US1.6 | Accounts and Access | Reset a forgotten password | Should | Done | M9 | `/auth/forgot`, `/auth/reset` | loyalty |
| N02 | new | Accounts and Access | Change my password | Should | Done | V1 | `/auth/change-password` | auth |
| N03 | new | Accounts and Access | See an audit log of staff actions | Should | Done | V1 | `services/audit.js`, `/admin/audit` | admin |
| ID-16 | US1.5b | Accounts and Access | See and delete my personal data | Could | Done | V5 | `/support/my-data`, `/support/delete-account` | support |
| ID-22 | US1.10 | Accounts and Access | Save favourite places | Could | Done | V5 | `/support/favourites` | support |
| N04 | new | Accounts and Access | Change system settings (discount %, cancel window, refund limit) | Could | Done | V1 | `/admin/settings` | admin |
| N05 | new | Accounts and Access | Delete personal data after 12 months | Could | Done | V5 | `jobs.js` retention | support |
| N29 | new | Accounts and Access | Add notes to a customer account | Could | Done | V5 | `/staff/customers/:id/notes` | support |
| ID-23 | US2.1 | Enquiries | Send a general enquiry | Should | Done | M8 | `routes/enquiries.js` | comms |
| ID-24 | US2.2 | Enquiries | Send an enquiry about a specific trip | Should | Done | M8 | `routes/enquiries.js` | comms |
| ID-25 | US2.3 | Enquiries | Staff view, reply to and send emails | Should | Done | M8 | `routes/enquiries.js` staff | comms |
| N14 | new | Enquiries | Read a help and FAQ page | Should | Done | V5 | `web/src/pages/Support.jsx` Help | browser |
| N20 | new | Enquiries | Contact the company during my journey | Should | Done | V3 | `routes/journey.js` incident, trip page call link | receipts |
| ID-27 | US2.5 | Enquiries | Chat with customer support | Could | Not built | - | Not built (Could). Customers use enquiries and the phone line. | - |
| ID-28 | US3.1 | Book a Cab | Choose a service | Must | Done | M4 | `pages/Book.jsx` | bookings |
| ID-29 | US3.2 | Book a Cab | Enter journey details | Must | Done | V2 | `services/booking.js` prepareJourney | booking_v3 |
| ID-30 | US3.3 | Book a Cab | Choose passengers and cab size | Must | Done | V2 | `prepareJourney`, `sizeProblems` | booking_v3 |
| ID-31 | US3.4 | Book a Cab | Get programme discounts automatically (15% online) | Must | Done | V2 | `services/pricing.js` computeQuote | pricing |
| ID-32 | US3.5 | Book a Cab | Review and confirm the booking | Must | Done | V2 | `acceptTerms`, price lines | booking_v3 |
| ID-33 | US3.6 | Book a Cab | View my bookings | Must | Done | M4 | `GET /bookings` | bookings |
| ID-35 | US3.8a | Book a Cab | Book for a verified caller | Must | Done | V2 | `POST /staff/bookings` | callcentre |
| ID-39 | US3.11 | Book a Cab | Request accessibility support (wheelchair, assistance dog, help to find the car) | Must | Done | V2 | accessibility, wheelchair cabs | booking_v3 |
| ID-75 | US3.15 | Book a Cab | Choose a daily hire package | Must | Done | V2 | `hire_packages` | booking_v3 |
| ID-36 | US3.8b | Book a Cab | Record payment for a phone or walk-in booking | Should | Done | V2 | `services/checkout.js` payStaff | callcentre |
| ID-38 | US3.10 | Book a Cab | Book for another passenger | Should | Done | V2 | passenger name and phone | booking_v3 |
| ID-41 | US3.13 | Book a Cab | Enter a flight number for an airport pickup | Should | Done | V2 | flight number | booking_v3 |
| N13 | new | Book a Cab | Get a fare estimate before signing in | Should | Done | V2 | public `POST /bookings/quote` | booking_v3 |
| ID-34 | US3.7 | Book a Cab | Priority for online users | Could | Done | M4 | `bookings.priority`, dispatch order | comms |
| ID-40 | US3.12 | Book a Cab | Book as soon as possible or for later | Could | Done | V2 | `asapTime` | booking_v3 |
| N15 | new | Book a Cab | Add a note to the driver | Could | Done | V2 | note to driver | booking_v3 |
| N16 | new | Book a Cab | Add a return journey to the same booking | Could | Done | V2 | return journey (`group_id`, `return_of`) | booking_v3 |
| N25 | new | Book a Cab | Rebook a past journey | Could | Done | V2 | Trip page "Book this journey again" | browser |
| N26 | new | Book a Cab | Change the destination during the journey | Could | Done | V4 | `services/journey.js` changeDestination | dispatch_v3 |
| ID-37 | US3.9 | Book a Cab | Add a business reference to a booking | Dropped | Dropped | - | Dropped in the report (replaced by N09) | - |
| ID-42 | US3.14 | Book a Cab | Book as a guest | Dropped | Dropped | - | Dropped in the report | - |
| ID-43 | US4.1 | Notifications | Choose email or text updates | Must | Done | M4 | `notify_pref` | comms |
| ID-44 | US4.2 | Notifications | Receive a booking confirmation email | Must | Done | V3 | `services/notify.js` queue + 3 retries | receipts |
| ID-45 | US4.3 | Notifications | Receive a text when the driver is near | Should | Done | V4 | `journey.js` arrival and late texts | comms, dispatch_v3 |
| ID-46 | US4.4 | Notifications | See my driver's name and photo | Should | Done | V4 | driver first name, licence, photo URL | dispatch_v3 |
| ID-47 | US4.5 | Notifications | Notifications page | Should | Done | V3 | Messages page with delivery status | receipts |
| N19 | new | Notifications | Get a reminder 24 hours before my journey | Should | Done | V3 | `jobs.js` reminders | receipts |
| N21 | new | Notifications | Share my trip with a contact | Could | Done | V3 | `routes/journey.js` share, `/track/:token` | receipts |
| N22 | new | Notifications | Press an emergency button | Could | Done | V3 | emergency incident | receipts |
| ID-48 | US5.1a | Availability and Payment | Check a cab of my size is free | Must | Done | M3/V2 | `services/availability.js` | fleet, bookings |
| ID-49 | US5.1b | Availability and Payment | Never double-book a cab | Must | Done | M3 | exclusion constraints + advisory lock | bookings |
| ID-51 | US5.2a | Availability and Payment | Calculate the base fare | Must | Done | V2 | `services/pricing.js` | pricing |
| ID-53 | US5.3a | Availability and Payment | Pay by credit or debit card | Must | Done | V2 | `services/checkout.js` 3D Secure | payments |
| ID-54 | US5.3b | Availability and Payment | Handle a declined card and retry | Must | Done | V2 | `POST /bookings/:id/pay` | payments |
| ID-58 | US5.5 | Availability and Payment | View available cabs and drivers | Must | Done | M3 | `/staff/availability`, `/options` | fleet |
| ID-50 | US5.1c | Availability and Payment | Suggest other times or sizes when no cab is free | Should | Done | V2 | `findAlternatives` | bookings |
| ID-55 | US5.4 | Availability and Payment | Pay with PayPal | Should | Done | V2 | redirect sessions (PayPal) | payments |
| ID-56 | US5.6 | Availability and Payment | Pay cash to the driver | Should | Done | V2 | cash to the driver | payments, dispatch_v3 |
| ID-76 | US5.8 | Availability and Payment | Manage prices | Should | Done | V2 | `routes/pricing.js` | booking_v3 |
| N27 | new | Availability and Payment | Issue a refund up to my limit | Should | Done | V4 | `journey.js` staffRefund | dispatch_v3 |
| ID-52 | US5.2b | Availability and Payment | Add surcharges for weather, zone and night | Could | Done | V2 | night, zone, weather surcharges | pricing, booking_v3 |
| ID-57 | US5.7 | Availability and Payment | Pay from a linked bank account | Could | Done | V2 | redirect sessions (bank) | payments |
| N31 | new | Availability and Payment | Add a cleaning or damage charge | Could | Done | V4 | `journey.js` extraCharge | dispatch_v3 |
| ID-59 | US6.1 | Receipt | View and print an online receipt | Must | Done | V3 | `services/receipts.js`, `routes/receipts.js` | receipts |
| ID-60 | US7.1 | Reviews and Ratings | Rate and review a completed journey | Should | Done | M9/V5 | `routes/reviews.js` (+hide) | loyalty, support |
| ID-61 | US7.2 | Reviews and Ratings | Staff view reviews | Could | Done | M9 | `/staff/reviews` | loyalty |
| ID-62 | US8.1 | Cancel or Amend | Cancel a booking | Must | Done | M6 | `services/changes.js` cancelBooking | changes |
| ID-63 | US8.2a | Cancel or Amend | Amend my booking | Must | Done | M6/V2 | `planAmendment` (no move into 24 h) | changes, booking_v3 |
| N17 | new | Cancel or Amend | Get a refund when I cancel in time | Must | Done | M6/V3 | refund + credit note on cancel | changes, receipts |
| ID-64 | US8.2b | Cancel or Amend | Pay or refund the price difference | Should | Partly | M6/V2 | Difference charged or refunded at once to the original method; the "pay within 24 hours or undo" path is not built | changes |
| ID-77 | US8.3 | Cancel or Amend | Cancel or amend for a caller | Should | Done | V4 | `/staff/bookings/:id/cancel`, `/amend` with reason | dispatch_v3 |
| N18 | new | Cancel or Amend | Be charged fairly for a late cancellation or no-show | Should | Done | V4 | no-show after 10 min, late fee | dispatch_v3 |
| ID-78 | US8.4 | Cancel or Amend | Company cancels a booking | Could | Done | V4 | `/staff/bookings/:id/company-cancel` | dispatch_v3 |
| ID-65 | US9.1 | Fleet and Driver Management | Add and manage minicabs | Must | Done | V4 | `routes/fleet.js` cabs + documents | fleet, dispatch_v3 |
| ID-66 | US9.2 | Fleet and Driver Management | Add and manage drivers | Must | Done | V4 | `routes/fleet.js` drivers + documents | fleet, dispatch_v3 |
| ID-67 | US9.3a | Fleet and Driver Management | Assign a free driver to a booking | Must | Done | V4 | `journey.js` assignDriver | comms, dispatch_v3 |
| ID-68 | US9.3b | Fleet and Driver Management | Update journey status | Must | Done | V4 | `journey.js` changeStatus | comms, dispatch_v3 |
| ID-79 | US9.4 | Fleet and Driver Management | See all bookings | Must | Done | M8/V4 | `/staff/dispatch` | comms |
| N30 | new | Fleet and Driver Management | Replace the car for an interrupted journey | Should | Done | V4 | interrupted + replacement car | dispatch_v3 |
| N34 | new | Fleet and Driver Management | See my assigned jobs | Should | Done | V4 | `routes/driver.js` jobs | dispatch_v3 |
| N35 | new | Fleet and Driver Management | Update a job: Arrived, Picked up, Completed | Should | Done | V4 | `/driver/jobs/:id/status` | dispatch_v3 |
| N36 | new | Fleet and Driver Management | Report a breakdown or a found item | Could | Done | V4 | `/driver/jobs/:id/report` | dispatch_v3 |
| ID-73 | US10.4a | Loyalty and Special Offers | Use coupons from my wallet | Should | Done | V2 | coupon wallet (`services/offers.js`) | loyalty |
| N32 | new | Loyalty and Special Offers | See a dashboard of bookings by channel | Should | Done | V6 | Manager dashboard by channel | loyalty |
| ID-69 | US10.1 | Loyalty and Special Offers | Track popular cars | Could | Done | M9 | `/staff/reports/popular` | loyalty |
| ID-70 | US10.2 | Loyalty and Special Offers | Track loyal customers | Could | Done | M9 | `/staff/customers-loyalty` | loyalty |
| ID-71 | US10.3a | Loyalty and Special Offers | Create an offer | Could | Done | V2 | `POST /staff/offers` (fixed amount) | loyalty |
| ID-72 | US10.3b | Loyalty and Special Offers | Send an offer to opted-in customers | Could | Done | V2 | offers only to opted-in customers | loyalty |
| N06 | new | Business Accounts | Apply for a company account | Should | Done | V6 | `POST /business/apply` | business |
| N07 | new | Business Accounts | Approve or reject a company application and set a credit limit | Should | Done | V6 | `/staff/companies/:id/approve|reject` | business |
| N08 | new | Business Accounts | Invite and remove company bookers | Should | Done | V6 | `/business/members/invite`, `/business/join` | business |
| N09 | new | Business Accounts | Book on the company account with a cost-centre reference | Should | Done | V6 | payment method `invoice` + cost centre | business |
| N10 | new | Business Accounts | Receive and pay a monthly company invoice | Could | Done | V6 | `issueInvoice`, `/business/invoices/:id/pay` | business |
| N11 | new | Business Accounts | Send overdue reminders and suspend unpaid accounts | Could | Done | V6 | `billingCheck` | business |
| N12 | new | Business Accounts | See all company bookings and spend | Could | Done | V6 | `/business/bookings` | business |
| N23 | new | Support | Report a lost item | Should | Done | V5 | `/support/lost-items` | support |
| N24 | new | Support | Make a complaint about a journey or driver | Should | Done | V5 | `/support/complaints` | support |
| N28 | new | Support | Log a found item and match it to a report | Should | Done | V5 | `/staff/lost-items` + automatic match | support |
| N33 | new | Support | Review complaints and act on drivers | Could | Done | V5 | `/staff/complaints/:id/driver-action` | support |
| N37 | new | Receipt | Save the receipt as a PDF (FR-6.4) | Must | Done | V3 | `GET /receipts/:id/pdf` | receipts |
| N38 | new | Receipt | Send the receipt by email (FR-6.5) | Must | Done | V3 | `POST /receipts/:id/send` | receipts |
| N39 | new | Receipt | Receipt history, credit notes (FR-6.7 to FR-6.10) | Must | Done | V3 | `GET /receipts`, credit notes | receipts |

**Summary (Appendix C):** 99 done, 1 partly, 1 not built, 2 dropped by the team.

## Gaps and differences from the report (for the evaluation chapter)

- **ID-27 chat with support (Could)** is not built; customers use enquiries, "Problem with my journey" and the phone line.
- **ID-64**: when an amendment costs more, the difference is charged to the original payment method at once. The report's
  "pay within 24 hours or the amendment is undone" path (for a card that fails) is not built.
- **Definition of Done line 2** says "the whole pytest suite passes". This build is Node.js, so the suite is
  `node --test` (`npm test` in `server/`). The report should say so.
- **Section 2.5 (red-team rows 1, 2, 4)** describe the 12 November build (409 on a duplicate email, lockout abuse, a public
  Swagger page). In this build all three are fixed: same reply for new and existing emails, lockout by account **and** IP
  with an email unlock link, and the API reference (`/api/docs`) is served in development only.
- Payments, email delivery (unless `SMTP_HOST` points at Mailpit), texts and GPS are simulated, as the report assumes.
