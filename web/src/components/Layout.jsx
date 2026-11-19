import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../icons.jsx';
import { isStaffRole, useAuth } from '../auth.jsx';

export function Brand({ to = '/' }) {
  return (
    <Link to={to} className="brand" aria-label="PrivateHire Cars home">
      <span className="brand-mark">
        <Icon name="car" size={18} />
      </span>
      PrivateHire
    </Link>
  );
}

const initials = (name = '') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0].toUpperCase())
    .join('');

function linksFor(user) {
  if (!user) {
    return [
      { to: '/services', label: 'Services' },
      { to: '/contact', label: 'Help & enquiries' },
    ];
  }
  if (isStaffRole(user)) return [{ to: '/staff', label: 'Staff area' }];
  return [
    { to: '/book', label: 'Book' },
    { to: '/trips', label: 'My trips' },
    { to: '/messages', label: 'Messages' },
    { to: '/contact', label: 'Help' },
  ];
}

export function Navbar() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const { user, logout } = useAuth();
  const nav = useNavigate();
  useEffect(() => setOpen(false), [pathname]);
  const links = linksFor(user);

  const doLogout = () => {
    nav('/', { replace: true }); // navigate first so the route guard does not redirect to /login
    logout();
  };

  return (
    <header className="navbar">
      <div className="container navbar-inner">
        <Brand to={user ? (isStaffRole(user) ? '/staff' : '/dashboard') : '/'} />
        <nav className="nav-links" aria-label="Main">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} className="nav-link">
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="nav-actions">
          {user ? (
            <>
              <Link to={isStaffRole(user) ? '/staff' : '/account'} className="row" style={{ gap: 8, textDecoration: 'none' }}>
                <span className="avatar" aria-hidden="true">{initials(user.fullName)}</span>
                <span className="small strong">{user.fullName.split(' ')[0]}</span>
              </Link>
              <button className="btn btn-subtle btn-sm" onClick={doLogout}>
                Log out
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="btn btn-subtle btn-sm">
                Log in
              </Link>
              <Link to="/register" className="btn btn-sm">
                Sign up
              </Link>
            </>
          )}
        </div>
        <button
          className="btn btn-ghost nav-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
        >
          <Icon name={open ? 'x' : 'menu'} />
        </button>
      </div>
      {open && (
        <div className="mobile-menu">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} className="nav-link">
              {l.label}
            </NavLink>
          ))}
          {user && (
            <NavLink to={isStaffRole(user) ? '/staff' : '/account'} className="nav-link">
              My account
            </NavLink>
          )}
          <hr />
          {user ? (
            <button className="btn btn-subtle btn-block btn-lg" onClick={doLogout}>
              Log out
            </button>
          ) : (
            <>
              <Link to="/login" className="btn btn-subtle btn-block btn-lg">
                Log in
              </Link>
              <Link to="/register" className="btn btn-block btn-lg">
                Sign up
              </Link>
            </>
          )}
        </div>
      )}
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-cols">
          <div>
            <div className="brand" style={{ color: '#fff', marginBottom: 12 }}>
              <span className="brand-mark" style={{ background: '#fff', color: '#ff385c' }}>
                <Icon name="car" size={18} />
              </span>
              PrivateHire
            </div>
            <p className="small" style={{ color: '#c9c9c9', maxWidth: 320 }}>
              London private hire since 2012. 150+ vehicles, one fast, friendly and reliable service.
            </p>
          </div>
          <div>
            <h4>Book</h4>
            <ul>
              <li><Link to="/book">Book a minicab</Link></li>
              <li><Link to="/services">Our services</Link></li>
              <li><Link to="/register">Create an account</Link></li>
            </ul>
          </div>
          <div>
            <h4>Help</h4>
            <ul>
              <li><Link to="/contact">Send an enquiry</Link></li>
              <li><Link to="/login">Log in</Link></li>
              <li><Link to="/staff/login">Staff sign in</Link></li>
            </ul>
          </div>
          <div>
            <h4>Contact</h4>
            <ul>
              <li><a href="tel:+442070000000">020 7000 0000</a></li>
              <li><a href="mailto:bookings@privatehire.example">bookings@privatehire.example</a></li>
            </ul>
          </div>
        </div>
        <p className="tiny" style={{ marginTop: 28, color: '#8a8a8a' }}>
          &copy; {new Date().getFullYear()} PrivateHire Cars. Coursework prototype for COMP1807 - payments, SMS, email and
          GPS are simulated.
        </p>
      </div>
    </footer>
  );
}

const TABS = [
  { to: '/dashboard', label: 'Home', icon: 'home' },
  { to: '/book', label: 'Book', icon: 'car' },
  { to: '/trips', label: 'Trips', icon: 'calendar' },
  { to: '/messages', label: 'Messages', icon: 'inbox' },
  { to: '/account', label: 'Account', icon: 'user' },
];

/** Phone-style bottom navigation for logged-in customers (hidden on desktop). */
function BottomBar() {
  return (
    <nav className="bottom-bar" aria-label="Customer">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon name={t.icon} size={22} />
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function PublicLayout() {
  const { user } = useAuth();
  const customer = user && !isStaffRole(user);
  return (
    <>
      <Navbar />
      <main id="main" className={customer ? 'has-bottom-bar' : ''}>
        <Outlet />
      </main>
      <Footer />
      {customer && <BottomBar />}
    </>
  );
}

const STAFF_NAV = [
  { to: '/staff', label: 'Dashboard', icon: 'grid', end: true },
  { to: '/staff/call-desk', label: 'Call desk', icon: 'headset' },
  { to: '/staff/dispatch', label: 'Dispatch', icon: 'route' },
  { to: '/staff/enquiries', label: 'Enquiries', icon: 'message' },
  { to: '/staff/availability', label: 'Availability', icon: 'map' },
  { to: '/staff/reviews', label: 'Reviews', icon: 'star' },
  { to: '/staff/offers', label: 'Offers', icon: 'gift' },
  { to: '/staff/reports', label: 'Reports', icon: 'chart', admin: true },
  { to: '/staff/fleet', label: 'Fleet', icon: 'car' },
  { to: '/staff/drivers', label: 'Drivers', icon: 'wheel' },
  { to: '/staff/outbox', label: 'Outbox', icon: 'inbox' },
];

export function StaffLayout() {
  const { user } = useAuth();
  const items = STAFF_NAV.filter((i) => !i.admin || user?.role === 'admin');
  return (
    <>
      <Navbar />
      <div className="staff-shell">
        <nav className="staff-nav" aria-label="Staff">
          {items.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              <Icon name={i.icon} size={18} />
              {i.label}
            </NavLink>
          ))}
        </nav>
        <main className="staff-main" id="main">
          <Outlet />
        </main>
      </div>
    </>
  );
}
