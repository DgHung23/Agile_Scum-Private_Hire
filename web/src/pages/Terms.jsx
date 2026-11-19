import { Link } from 'react-router-dom';
import { PageHeader } from '../ui.jsx';

/** ID-32: terms and cancellation policy the customer accepts before paying (report Table 13: CCR 2013 reg. 27(2)(c)). */
export default function Terms() {
  return (
    <div className="container page">
      <div className="medium stack-lg">
        <PageHeader title="Terms and cancellation policy" sub="Please read these before you pay. They are short." />
        <section className="card stack">
          <h3>Booking</h3>
          <p>Book at least 30 minutes and up to 90 days ahead. The price you see is calculated by us and does not change because of
            traffic or a diversion. Every online booking is 15% cheaper than phone or walk-in bookings, and you can use one coupon
            per booking. The fare never falls below £5.</p>
          <p>Your cab is held for 15 minutes while you pay. Card payments are checked with your bank (3D Secure).</p>
        </section>
        <section className="card stack">
          <h3>Cancelling or changing</h3>
          <p>You can cancel or change a booking online free of charge until 24 hours before the pickup time (UK time). If you cancel
            in time you get a full refund to the way you paid, usually within 3 to 5 working days. After that, please call us on
            020 7000 0000; a late cancellation or a no-show (after 10 minutes of free waiting) may be charged.</p>
          <p>If your driver is more than 15 minutes late you can cancel free of charge. If we cannot provide a cab we offer another time
            or size first, otherwise we refund you in full.</p>
          <p>The 14-day cancellation right in the Consumer Contracts Regulations does not cover passenger transport, so this policy applies instead.</p>
        </section>
        <section className="card stack">
          <h3>Accessibility</h3>
          <p>We never charge extra for a wheelchair-accessible vehicle, an assistance dog, or help to find the car (Equality Act 2010).</p>
        </section>
        <section className="card stack">
          <h3>Your data</h3>
          <p>We keep booking records for 12 months, as Transport for London requires, and never store your full card number.</p>
        </section>
        <p className="small"><Link to="/book" className="strong">Back to booking</Link></p>
      </div>
    </div>
  );
}
