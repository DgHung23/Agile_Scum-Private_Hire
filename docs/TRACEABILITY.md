# Traceability: requirement -> story -> sprint -> code -> test

Use this table as evidence that every Product Owner requirement (R1-R14) is delivered and tested. "Test" names refer to
`server/test/*.test.js`; browser behaviour was checked with scripted end-to-end runs at 1366px and 390px during each module.

## Product Owner requirements

| R | Requirement (short) | Stories | Sprint |
|---|---|---|---|
| R1 | Register, profile, confirmation email | US1.1, 1.2, 1.4, 1.5 | 1, 2 |
| R2 | General and trip enquiries | US2.1, 2.2, 2.3 | 3 |
| R3 | Online / in-person / phone booking, 15% online discount | US3.4, US9.5 | 2, 3 |
| R4 | Choose a service | US3.1 | 2 |
| R5 | Online booking details, passengers, cab size, login | US1.3, 3.2, 3.3, 3.5 | 1, 2 |
| R6 | Email or text back, text 10-15 min before arrival | US4.1, 4.2, 4.3 | 2, 3 |
| R7 | Availability, price, payment, card check, PayPal | US5.1-5.4 | 1, 2 |
| R8 | Online receipt | US6.1 | 2 |
| R9 | Review and star rating | US7.1, 7.2 | 3 |
| R10 | Cancel or amend 24h before | US8.1, 8.2 | 2 |
| R11 | Caller verification | US9.2, 9.3 | 3 |
| R12 | Staff see cabs, drivers, prices, availability | US9.4 | 1, 3 |
| R13 | Staff email, replies, create accounts / cabs / drivers / bookings | US2.3, 9.3, 9.5-9.8 | 1, 3 |
| R14 | Track popular cars and loyal customers, offers and codes | US10.1-10.4 | 3 |

## Stories

| Story | Delivered in | Main code | Test (file: name) |
|---|---|---|---|
| US1.1 Register | M2 Sprint 1 | `routes/auth.js`, `components/ProfileForm.jsx` | auth: "US1.1 register..." (3 tests) |
| US1.2 Confirmation email | M2 | `services/notify.js` | auth: "US1.2 confirmation email..." |
| US1.3 Log in / out | M2 | `middleware/auth.js`, `auth.jsx` | auth: "US1.3 ..." (2 tests); browser: Back after logout |
| US1.4 Saved cards | M5 Sprint 2 | `routes/payments.js`, `pages/Account.jsx` | payments: "US1.4 saved cards..." |
| US1.5 Edit profile | M2 | `routes/auth.js` PATCH /me | auth: "US1.5 edit profile..." |
| US1.6 Reset password | M9 Sprint 3 | `routes/auth.js` /forgot, /reset | loyalty: "US1.6 ..." (2 tests) |
| US2.1 General enquiry | M8 | `routes/enquiries.js`, `pages/Contact.jsx` | comms: "US2.1 ..." |
| US2.2 Trip enquiry | M8 | same | comms: "US2.2 ..." |
| US2.3 Staff inbox + reply | M8 | `routes/enquiries.js`, `staff/Enquiries.jsx` | comms: "US2.3 ..." |
| US3.1 Choose service | M4 Sprint 2 | `pages/Book.jsx`, `services/booking.js` | bookings: "US3.1 airport services..." |
| US3.2 Journey details | M4 | `prepareJourney` | bookings: "US3.2 validation..." |
| US3.3 Passengers and cab size | M4 | `prepareJourney`, `createBooking` | bookings: "US3.3 too many passengers..." |
| US3.4 15% online discount | M4 | `services/pricing.js` | pricing: "R3 ..." (2 tests); callcentre: "US9.5 ... no 15%" |
| US3.5 Review and confirm | M4 | `routes/bookings.js` POST / | bookings: "US3.5 / US3.4 / US3.7 / US4.2 ..." |
| US3.6 My bookings | M4 | `routes/bookings.js` GET / | bookings: "US3.6 my bookings..." |
| US3.7 Priority | M4, M8 | `bookings.priority`, `routes/dispatch.js` | comms: "US9.9 dispatch board ... priority first" |
| US4.1 Email or text choice | M4 | `notify_pref` | comms: "US4.1 email-only customers..." |
| US4.2 Confirmation email | M4, M5 | `bookingConfirmationEmail` | bookings, payments ("Paid with: Visa...") |
| US4.3 Text near arrival | M8 | `routes/dispatch.js` | comms: "US4.3 on route with ETA <= 15..." |
| US5.1 Availability | M3 Sprint 1, M4 | `services/availability.js`, exclusion constraints | fleet: "US5.1 ..." (2); bookings: "US5.1 ..." (2); changes |
| US5.2 Price | M4 | `services/pricing.js` | pricing (all) |
| US5.3 Card payment | M5 | `services/payments.js` | payments: "US5.3 ..." (4 tests) |
| US5.4 PayPal | M5 | `routes/payments.js`, `PayPalMock.jsx` | payments: "US5.4 PayPal..." |
| US6.1 Receipt | M5 | `buildReceipt`, `pages/Receipt.jsx` | payments: receipt assertions |
| US7.1 Review | M9 | `routes/reviews.js` | loyalty: "US7.1 ..." (2) |
| US7.2 Staff view reviews | M9 | `staff/Reviews.jsx` | loyalty: "US7.2 ..." |
| US8.1 Cancel | M6 | `services/changes.js` | changes: "US8.1 ...", "R10 ..." (3) |
| US8.2 Amend | M6 | `services/changes.js`, `pages/Amend.jsx` | changes: "US8.2 ..." (5) |
| US9.1 Staff login | M2 | `/auth/staff-login` | auth: "US9.1 ..." (2) |
| US9.2 Verify caller | M7 Sprint 3 | `routes/callcentre.js` | callcentre: "US9.2 ..." (5) |
| US9.3 New caller account | M7 | same | callcentre: "US9.3 ..." |
| US9.4 Availability + prices | M3, M7 | `routes/fleet.js`, `StaffAvailability.jsx` | fleet: "US9.4 ..."; callcentre: "US9.4 ..." |
| US9.5 Staff booking | M7 | `routes/callcentre.js` | callcentre: "US9.5 ..." (3) |
| US9.6 Cabs | M3 | `routes/fleet.js`, `staff/Fleet.jsx` | fleet: "US9.6 ..." (3) |
| US9.7 Drivers | M3 | same | fleet: "US9.7 ..." |
| US9.8 Email a customer | M8 | `routes/enquiries.js` | comms: "US9.8 ..." |
| US9.9 Assign + status | M8 | `routes/dispatch.js`, `staff/Dispatch.jsx` | comms: "US9.9 ..." (3) |
| US10.1 Popular cars | M9 | `routes/loyalty.js` /reports/popular | loyalty: "US10.1 ..." |
| US10.2 Loyal customers | M9 | `/customers-loyalty` | loyalty: "US10.2 ..." |
| US10.3 Send offers | M9 | `/offers`, `/offers/recommend` | loyalty: "US10.3 ...", "R14 recommendations" |
| US10.4 Redeem code | M9 | `services/offers.js` | loyalty: "US10.4 ..." (5) |
