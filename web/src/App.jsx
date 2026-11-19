import { Route, Routes } from 'react-router-dom';
import { PublicLayout, StaffLayout } from './components/Layout.jsx';
import { RequireAuth } from './auth.jsx';
import Home from './pages/Home.jsx';
import ComingSoon from './pages/ComingSoon.jsx';
import { Login, Register, StaffLogin } from './pages/Auth.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Account from './pages/Account.jsx';
import Messages from './pages/Messages.jsx';
import Book from './pages/Book.jsx';
import Services from './pages/Services.jsx';
import { TripDetail, Trips } from './pages/Trips.jsx';
import StaffHome, { StaffOutbox } from './pages/staff/StaffHome.jsx';
import { StaffDrivers, StaffFleet } from './pages/staff/Fleet.jsx';

const customer = (el) => <RequireAuth roles={['customer']}>{el}</RequireAuth>;

export default function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<Home />} />
        <Route path="login" element={<Login />} />
        <Route path="register" element={<Register />} />
        <Route path="staff/login" element={<StaffLogin />} />
        <Route path="book" element={<Book />} />
        <Route path="services" element={<Services />} />
        <Route path="trips" element={customer(<Trips />)} />
        <Route path="trips/:id" element={customer(<TripDetail />)} />
        <Route path="dashboard" element={customer(<Dashboard />)} />
        <Route path="account" element={customer(<Account />)} />
        <Route path="messages" element={customer(<Messages />)} />
        <Route path="*" element={<ComingSoon title="Page coming soon" />} />
      </Route>
      <Route
        path="staff"
        element={
          <RequireAuth roles={['staff', 'admin']}>
            <StaffLayout />
          </RequireAuth>
        }
      >
        <Route index element={<StaffHome />} />
        <Route path="fleet" element={<StaffFleet />} />
        <Route path="drivers" element={<StaffDrivers />} />
        <Route path="outbox" element={<StaffOutbox />} />
      </Route>
    </Routes>
  );
}
