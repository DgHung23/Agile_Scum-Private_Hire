# PrivateHire Cars – Product Vision and User Stories (draft)

Draft written 15 Oct 2026 from the 14 Product Owner requirements in [PrivateHire-requirements.md](PrivateHire-requirements.md). It follows the course format (Tutorials 4 and 5): "As a… I want… So that…", numbered acceptance criteria, epics broken into smaller stories, and MoSCoW priority.

- **R#** is the Product Owner requirement the story comes from.
- **MoSCoW** is my suggestion. Your Product Owner (the tutor) decides the final order.
- **Points** are left blank on purpose. Estimate them as a team with Planning Poker (1, 2, 3, 5, 8, 13, 20, 40, 100) and keep photos or screenshots as evidence. Anything 13 or above is an epic and should be split again.
- Stories marked **(added)** are not in the Product Owner's list. They are needed for the system to work (for example, login or a staff dashboard). Confirm them with your tutor.

---

## Product Vision (draft)

**For** customers of PrivateHire Cars, especially younger adults and business clients, and the Call Centre staff who serve them
**Who** want to book a minicab quickly, privately and safely at any time
**The** PrivateHire Cars Online Booking System **is a** web-based booking and customer management system
**That** lets customers register, book, pay, track and review journeys online, and lets staff handle phone bookings, drivers and offers in one place
**Unlike** the current phone-only process, which keeps the Call Centre overloaded
**Our product** gives online customers a 15% discount and priority service, sends text confirmation with the car's details to prevent bogus pickups, and builds customer profiles for loyalty offers.

---

## Roles (actors)

- **Visitor**: not registered yet
- **Registered Customer**: has an account and is logged in
- **Call Centre Staff**: also called Sales Staff in R13
- **Admin / Manager**: George Smith's view of reports *(added)*
- **External systems**: Email service, SMS service, PayPal, VISA Check (bank), GPS Despatch System

---

## Epic E1 – Customer Account (R1, R5)

**US1.1 Register an account** · R1 · Must
As a Visitor, I want to register with my name, email, address, telephone number and password, so that I can book minicabs online.
1. All fields are required, and the email and phone number must be in a valid format.
2. An email that is already registered is rejected with a message.
3. The password has a minimum length, and it is stored hashed, never in plain text.
4. On success, the account is created and the user is taken to the login page.

**US1.2 Receive a registration confirmation email** · R1 · Must
As a new Customer, I want to receive a confirmation email after I register, so that I know my account was created.
1. An email is sent to the registered address within 1 minute.
2. It contains the customer's name and a link to log in.

**US1.3 Log in and log out** · R5 · Must *(added)*
As a Registered Customer, I want to log in and log out, so that only I can access my bookings and details.
1. A correct email and password open the customer dashboard.
2. Wrong details show an error without saying which field was wrong.
3. Logging out ends the session, and the Back button does not reopen the dashboard.

**US1.4 Save card details to my profile** · R1 · Should
As a Registered Customer, I want to save my card details in my profile, so that I can pay faster next time.
1. Only the last 4 digits and the expiry date are ever displayed.
2. The customer can delete a saved card.

**US1.5 View and edit my profile** · R1 · Should
As a Registered Customer, I want to view and update my details, so that my information stays correct.
1. Changes are saved and shown straight away.
2. The same validation as registration applies.

**US1.6 Reset a forgotten password** · Could *(added)*
As a Registered Customer, I want to reset my password by email, so that I can get back into my account.

---

## Epic E2 – Enquiries (R2, R13)

**US2.1 Send a general enquiry** · R2 · Should
As a Visitor or Customer, I want to send a general question to the company, so that I can get information before booking.
1. The form has name, email, subject and message, and all are required.
2. On submit, a confirmation message is shown and the enquiry appears in the staff inbox.

**US2.2 Send an enquiry about a specific trip** · R2 · Should
As a Registered Customer, I want to send an enquiry linked to one of my bookings, so that staff know exactly which journey I mean.
1. The customer picks the booking from a list of their bookings.
2. Staff see the booking reference together with the enquiry.

**US2.3 Staff view and reply to enquiries** · R13, R2 · Should
As Call Centre Staff, I want to see all enquiries and reply to them, so that customers get answers quickly.
1. Enquiries are listed newest first with a status (New, Replied).
2. A reply is emailed to the customer and the status changes to Replied.

---

## Epic E3 – Online Booking (R3, R4, R5)

**US3.1 Choose a service** · R4 · Must
As a Registered Customer, I want to choose the type of service, so that I book the journey I need.
1. The options are Local journey, Long distance, Airport transfer, Hotel transfer, Meet & greet at airport, and Driver & car daily hire.
2. A service must be chosen before continuing.

**US3.2 Enter journey details** · R5 · Must
As a Registered Customer, I want to enter the pickup location, destination, date and time, so that the company knows where and when to collect me.
1. All four fields are required.
2. A date or time in the past is rejected.
3. Pickup and destination cannot be the same.

**US3.3 Choose passengers and cab size** · R5 · Must
As a Registered Customer, I want to enter the number of passengers and choose the cab size (for example a 4-seater or a 7-seater), so that everyone fits.
1. The number of passengers must be between 1 and the seats of the chosen cab size.
2. Cab sizes too small for the passenger number are disabled.

**US3.4 Get the 15% online discount** · R3 · Must
As a Registered Customer, I want my online booking to get a 15% discount, so that I save money by booking online.
1. The price summary shows the full price, the 15% discount and the final price.
2. The discount applies only to online bookings, not to Call Centre or in-person bookings.

**US3.5 Review and confirm the booking** · R5, R6 · Must
As a Registered Customer, I want to see a summary before I confirm, so that I can check everything is right.
1. The summary shows service, pickup, destination, date, time, passengers, cab size and price.
2. An Edit button goes back without losing the details entered.
3. On confirm, a unique booking reference is created and the status is Confirmed.

**US3.6 View my bookings** · R8, R10 · Must *(added: needed to reopen receipts and to cancel or amend)*
As a Registered Customer, I want to see my upcoming and past bookings, so that I can keep track of my journeys.
1. Upcoming and past bookings are shown separately, with reference, date, route and status.

**US3.7 Priority for online users** · Could *(from the business goals)*
As a Registered Customer, I want my online booking to be given priority over phone bookings, so that I get faster service.
1. Online bookings are flagged as Priority in the staff and despatch view.

---

## Epic E4 – Notifications (R6)

**US4.1 Choose email or text updates** · R6 · Must
As a Registered Customer, I want to choose whether I get updates by Email, Text or both, so that I am contacted the way I prefer.
1. The choice is made during booking and saved with the booking.
2. If Text is chosen, the phone number on the profile is used and shown for checking.

**US4.2 Receive a booking confirmation email** · R6 · Must
As a Registered Customer, I want an email when my booking is confirmed, so that I have a record of it.
1. The email shows the booking reference and all journey details.

**US4.3 Receive a text when the driver is near** · R6, BG4 · Should
As a Registered Customer, I want a text 10–15 minutes before arrival with the car's registration, colour and make, so that I know I'm getting into the right car.
1. The text is sent when the driver's status is "On route" and the expected arrival time is 10–15 minutes away.
2. It includes the registration number, colour and make.
3. *In the prototype, this can be simulated: a staff button sets "On route" and the message appears in a log or test inbox.*

---

## Epic E5 – Availability and Payment (R7)

**US5.1 Check cab availability** · R7 · Must
As a Registered Customer, I want the system to check that a cab of my chosen size is free at my time, so that my booking can actually be fulfilled.
1. If no cab is free, the customer sees a message and can pick another time or size.
2. A cab cannot be double-booked for overlapping times.

**US5.2 Calculate the total price** · R7 · Must
As a Registered Customer, I want to see the total price before I pay, so that I know the cost.
1. The price is based on service, distance (or hours for daily hire) and cab size, using a rate table.
2. Discounts and offer codes are applied before the total is shown.

**US5.3 Pay by credit or debit card** · R7 · Must
As a Registered Customer, I want to pay by Visa, Mastercard or American Express, so that I can pay with my usual card.
1. The card number, expiry and CVV are validated (format, expiry in the future, Amex has 15 digits).
2. Card details are checked through VISA Check *(simulated in the prototype)*.
3. If the card is declined, a clear error is shown and the booking is not confirmed.

**US5.4 Pay with PayPal** · R7 · Should
As a Registered Customer, I want to pay with PayPal, so that I don't have to enter card details.
1. The customer is sent to PayPal (sandbox or mock) and returned to a success or failure page.

---

## Epic E6 – Receipt (R8)

**US6.1 View and print an online receipt** · R8 · Must
As a Registered Customer, I want a printable receipt after paying, so that I have proof of my journey and its cost.
1. The receipt shows the booking reference, journey details, discount, final cost, payment method and date paid.
2. A Print button opens the browser's print view.
3. The receipt can be opened again later from My Bookings.

---

## Epic E7 – Reviews and Ratings (R9)

**US7.1 Rate and review a completed journey** · R9 · Should
As a Registered Customer, I want to give a 1–5 star rating and a comment on my journey, the minicab and the driver, so that I can share my experience.
1. Reviews are only allowed after the booking's status is Completed.
2. There are three separate ratings: journey, minicab and driver.
3. Only one review is allowed per booking.

**US7.2 Staff view reviews** · R9 · Could *(added)*
As Call Centre Staff, I want to see reviews and average ratings by driver and by car, so that service problems can be spotted.

---

## Epic E8 – Cancel or Amend (R10)

**US8.1 Cancel a booking** · R10 · Must
As a Registered Customer, I want to cancel a booking, so that I don't pay for a journey I no longer need.
1. Cancel is only possible up to 24 hours before pickup. After that, the button is disabled with an explanation.
2. The customer must confirm the cancellation.
3. The status changes to Cancelled, the cab becomes available again, and a cancellation email is sent.

**US8.2 Amend a booking** · R10 · Must
As a Registered Customer, I want to change the time, date, addresses or passengers of a booking, so that I can update my plans.
1. Amend is only possible up to 24 hours before pickup.
2. Availability and price are re-checked, and any difference is shown before saving.
3. An updated confirmation email is sent.

---

## Epic E9 – Call Centre Staff (R3, R11, R12, R13)

**US9.1 Staff log in** · Must *(added: enables all R11–R13 staff stories)*
As Call Centre Staff, I want a separate staff login, so that only staff can see staff screens.
1. A customer account cannot open staff pages.

**US9.2 Verify a caller** · R11 · Must
As Call Centre Staff, I want to search for a caller by name, phone, email or booking reference and ask security questions, so that I know I'm talking to the real account owner.
1. Search returns matching accounts.
2. Staff must tick "Identity verified" before the account details open.

**US9.3 Create an account for a new caller** · R11, R13 · Must
As Call Centre Staff, I want to create a customer account during a call, so that new callers can be booked straight away.
1. The same validation as US1.1 applies, and a confirmation email is sent to the customer.

**US9.4 View available cabs and drivers** · R12 · Must
As Call Centre Staff, I want to see which cabs and drivers are free at a given date and time, together with prices, so that I can tell callers accurately.
1. Staff can filter by date, time and cab size.
2. The list shows car, size, driver and estimated price.

**US9.5 Make a booking for a caller** · R3, R13 · Must
As Call Centre Staff, I want to make a booking on behalf of a phone or walk-in customer, so that customers who don't book online are still served.
1. The same booking steps and checks apply as for online bookings.
2. The 15% online discount is **not** applied.
3. The booking is recorded with its channel (Phone or In person).

**US9.6 Add and manage minicabs** · R13 · Must *(availability in US5.1 and US9.4 needs fleet data)*
As Call Centre Staff, I want to add, edit and deactivate minicabs (registration, make, colour, seats), so that the fleet list is up to date.
1. Registration numbers must be unique.

**US9.7 Add and manage drivers** · R13 · Must *(US9.9 needs drivers to assign)*
As Call Centre Staff, I want to add, edit and deactivate drivers, so that bookings can be assigned to real drivers.

**US9.8 Email a customer** · R13 · Should
As Call Centre Staff, I want to send an email to a customer from the system, so that all contact is recorded in one place.

**US9.9 Assign a driver and update journey status** · R6, R9 · Must *(added, needed for texts and reviews)*
As Call Centre / Control Centre Staff, I want to assign a driver and cab to a booking and set its status (Assigned, On route, Completed), so that the customer gets their text and can review afterwards.

---

## Epic E10 – Loyalty and Special Offers (R14)

**US10.1 Track popular cars** · R14, BG5 · Could
As a Manager, I want a report of the most-booked cars and cab sizes, so that I can plan the fleet and car rental business.

**US10.2 Track loyal customers** · R14, BG5 · Could
As a Manager, I want a report of customers ranked by number of bookings and amount spent, so that I can reward loyal customers.

**US10.3 Send special offers** · R14, BG5 · Could
As Staff, I want to create an offer code (percentage off, expiry date) and send it to selected customers, so that we encourage repeat bookings.
1. Each code has a unique value, a discount and an expiry date.
2. An email with the code is sent to the selected customers.

**US10.4 Redeem an offer code** · R14 · Should
As a Registered Customer, I want to enter an offer code when booking, so that I get my discount.
1. A valid code reduces the price, and the new total is shown.
2. A code that is invalid, expired or already used shows an error.
3. *Check with the Product Owner whether the code is added to the 15% online discount or replaces it.*

---

## Suggested MVP (the minimum for the demo)

The smallest end-to-end journey: **US1.1 → US1.3 → US3.1 → US3.2 → US3.3 → US5.1 → US5.2 → US3.4 → US3.5 → US5.3 → US6.1 → US4.2**, plus **US8.1** for the 24-hour rule, and **US9.1 → US9.6 → US9.5** for the Call Centre side (fleet data must exist before availability can be checked). Put these in Sprint 1 and Sprint 2. The Should and Could stories fill Sprint 3 and are what you "discuss as future work" in the demo.

## Questions to ask the Product Owner (tutor)

1. Can payment, email, SMS and GPS be simulated in the prototype?
2. Is an offer code added to the 15% online discount, or does it replace it?
3. How is the price calculated: per mile, fixed zones, or a fixed price per service?
4. What can be changed in an amendment? Can the service type be changed?
5. Does "in person" booking (R3) need its own screen, or is it handled by staff the same way as a phone booking?
