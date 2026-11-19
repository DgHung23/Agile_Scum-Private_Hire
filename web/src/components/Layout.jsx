import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Icon } from '../icons.jsx';

export function Brand() {
  return (
    <Link to="/" className="brand" aria-label="PrivateHire Cars home">
      <span className="brand-mark">
        <Icon name="car" size={18} />
      </span>
      PrivateHire
    </Link>
  );
}

const PUBLIC_LINKS = [
  { to: '/services', label: 'Services' },
  { to: '/contact', label: 'Help & enquiries' },
];

export function Navbar() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <header className="navbar">
      <div className="container navbar-inner">
        <Brand />
        <nav className="nav-links" aria-label="Main">
          {PUBLIC_LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className="nav-link">
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="nav-actions">
          <Link to="/login" className="btn btn-subtle btn-sm">
            Log in
          </Link>
          <Link to="/register" className="btn btn-sm">
            Sign up
          </Link>
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
          {PUBLIC_LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className="nav-link">
              {l.label}
            </NavLink>
          ))}
          <hr />
          <Link to="/login" className="btn btn-subtle btn-block btn-lg">
            Log in
          </Link>
          <Link to="/register" className="btn btn-block btn-lg">
            Sign up
          </Link>
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
              <span className="brand-mark" style={{ background: '#fff', color: '#000' }}>
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

export function PublicLayout() {
  return (
    <>
      <Navbar />
      <main id="main">
        <Outlet />
      </main>
      <Footer />
    </>
  );
}
