import { Route, Routes } from 'react-router-dom';
import { PublicLayout, StaffLayout } from './components/Layout.jsx';
import { RequireAuth } from './auth.jsx';
import Home from './pages/Home.jsx';
import ComingSoon from './pages/ComingSoon.jsx';
import { ForgotPassword, Login, Register, ResetPassword, StaffLogin, Unlock, VerifyEmail } from './pages/Auth.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Account from './pages/Account.jsx';
import Messages from './pages/Messages.jsx';
import Book from './pages/Book.jsx';
import Services from './pages/Services.jsx';
import { PayPending, TripDetail, Trips } from './pages/Trips.jsx';
import Receipt, { ReceiptById, Receipts, StaffReceipt } from './pages/Receipt.jsx';
import Track from './pages/Track.jsx';
import Driver from './pages/Driver.jsx';
import Support, { Help } from './pages/Support.jsx';
import SupportDesk from './pages/staff/SupportDesk.jsx';
import BookingManage from './pages/staff/BookingManage.jsx';
import Amend from './pages/Amend.jsx';
import ProviderMock from './pages/PayPalMock.jsx';
import Terms from './pages/Terms.jsx';
import StaffHome, { StaffOutbox } from './pages/staff/StaffHome.jsx';
import { StaffDrivers, StaffFleet } from './pages/staff/Fleet.jsx';
import { CallDesk, CallDeskCustomer, NewCaller } from './pages/staff/CallDesk.jsx';
import StaffBook from './pages/staff/StaffBook.jsx';
import StaffAvailability from './pages/staff/StaffAvailability.jsx';
import StaffEnquiries from './pages/staff/Enquiries.jsx';
import Dispatch from './pages/staff/Dispatch.jsx';
import StaffReviews from './pages/staff/Reviews.jsx';
import StaffOffers from './pages/staff/Offers.jsx';
import StaffReports from './pages/staff/Reports.jsx';
import Contact from './pages/Contact.jsx';
import { AuditLog, Settings, StaffAccounts } from './pages/staff/Admin.jsx';
import Pricing from './pages/staff/Pricing.jsx';

const customer = (el) => <RequireAuth roles={['customer']}>{el}</RequireAuth>;
const only = (roles, el) => <RequireAuth roles={roles}>{el}</RequireAuth>;
const DESK = ['staff', 'manager'];

export default function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<Home />} />
        <Route path="login" element={<Login />} />
        <Route path="register" element={<Register />} />
        <Route path="forgot-password" element={<ForgotPassword />} />
        <Route path="reset-password" element={<ResetPassword />} />
        <Route path="verify-email" element={<VerifyEmail />} />
        <Route path="unlock" element={<Unlock />} />
        <Route path="staff/login" element={<StaffLogin />} />
        <Route path="book" element={<Book />} />
        <Route path="services" element={<Services />} />
        <Route path="contact" element={<Contact />} />
        <Route path="trips" element={customer(<Trips />)} />
        <Route path="trips/:id" element={customer(<TripDetail />)} />
        <Route path="trips/:id/amend" element={customer(<Amend />)} />
        <Route path="trips/:id/receipt" element={customer(<Receipt />)} />
        <Route path="pay/provider" element={customer(<ProviderMock />)} />
        <Route path="trips/:id/pay" element={customer(<PayPending />)} />
        <Route path="terms" element={<Terms />} />
        <Route path="dashboard" element={customer(<Dashboard />)} />
        <Route path="account" element={customer(<Account />)} />
        <Route path="messages" element={customer(<Messages />)} />
        <Route path="receipts" element={customer(<Receipts />)} />
        <Route path="receipts/:rid" element={customer(<ReceiptById />)} />
        <Route path="track/:token" element={<Track />} />
        <Route path="help" element={<Help />} />
        <Route path="support" element={customer(<Support />)} />
        <Route path="driver" element={<RequireAuth roles={['driver']}><Driver /></RequireAuth>} />
        <Route path="*" element={<ComingSoon title="Page coming soon" />} />
      </Route>
      <Route
        path="staff"
        element={
          <RequireAuth roles={['staff', 'manager', 'admin']}>
            <StaffLayout />
          </RequireAuth>
        }
      >
        <Route index element={only(DESK, <StaffHome />)} />
        <Route path="call-desk" element={only(DESK, <CallDesk />)} />
        <Route path="call-desk/new" element={only(DESK, <NewCaller />)} />
        <Route path="call-desk/:id" element={only(DESK, <CallDeskCustomer />)} />
        <Route path="call-desk/:id/book" element={only(DESK, <StaffBook />)} />
        <Route path="dispatch" element={only(DESK, <Dispatch />)} />
        <Route path="enquiries" element={only(DESK, <StaffEnquiries />)} />
        <Route path="reviews" element={only(DESK, <StaffReviews />)} />
        <Route path="offers" element={only(['manager'], <StaffOffers />)} />
        <Route path="pricing" element={only(['manager'], <Pricing />)} />
        <Route path="reports" element={only(['manager'], <StaffReports />)} />
        <Route path="availability" element={only(DESK, <StaffAvailability />)} />
        <Route path="fleet" element={only(DESK, <StaffFleet />)} />
        <Route path="drivers" element={only(DESK, <StaffDrivers />)} />
        <Route path="outbox" element={only(DESK, <StaffOutbox />)} />
        <Route path="receipts/:rid" element={only(DESK, <StaffReceipt />)} />
        <Route path="bookings/:id" element={only(DESK, <BookingManage />)} />
        <Route path="support" element={only(DESK, <SupportDesk />)} />
        <Route path="admin/staff" element={only(['admin'], <StaffAccounts />)} />
        <Route path="admin/settings" element={only(['admin'], <Settings />)} />
        <Route path="admin/audit" element={only(['admin'], <AuditLog />)} />
      </Route>
    </Routes>
  );
}
