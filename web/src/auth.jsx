import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, setUnauthorizedHandler } from './api.js';
import { Loading } from './ui.jsx';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

/** Roles that sign in from the staff sign-in page (report Table 7). Manager inherits Call Centre Staff. */
export const PORTAL_ROLES = ['staff', 'manager', 'admin', 'driver'];
export const isStaffRole = (u) => !!u && PORTAL_ROLES.includes(u.role);
export const handlesBookings = (u) => !!u && (u.role === 'staff' || u.role === 'manager');
export const isManager = (u) => u?.role === 'manager';

/** Where each role lands after signing in. */
export const homeFor = (u) => {
  if (!u) return '/';
  if (u.role === 'customer') return '/dashboard';
  if (u.role === 'driver') return '/driver';
  if (u.role === 'admin') return '/staff/admin/staff';
  return '/staff';
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const [notice, setNotice] = useState('');

  const clear = useCallback((code) => {
    setUser((u) => {
      // ID-13 criterion 5: tell the person why they were signed out.
      if (u && code === 'session_expired') setNotice('Your session ended after 30 minutes without activity. Please log in again.');
      return null;
    });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(clear);
    // The session cookie is HttpOnly, so ask the server whether we are signed in.
    api
      .probe('/auth/session')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, [clear]);

  const value = useMemo(
    () => ({
      user,
      ready,
      loggedOut,
      notice,
      clearNotice: () => setNotice(''),
      async login(email, password, { staff = false } = {}) {
        const r = await api.post(staff ? '/auth/staff-login' : '/auth/login', { email, password });
        setLoggedOut(false);
        setNotice('');
        setUser(r.user);
        return r.user;
      },
      logout() {
        api.post('/auth/logout').catch(() => {});
        setLoggedOut(true);
        setUser(null);
      },
      refresh: () => api.get('/auth/me').then((r) => setUser(r.user)),
      setUser,
    }),
    [user, ready, loggedOut, notice],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

/**
 * Route guard. Redirects with `replace` so the Back button cannot reopen a protected page after logout
 * (ID-13 criterion 4). `roles` limits who may enter; the server checks the role again on every call (403).
 */
export function RequireAuth({ roles, children }) {
  const { user, ready, loggedOut } = useAuth();
  const loc = useLocation();
  if (!ready) return <Loading />;
  if (!user && loggedOut) return <Navigate to="/" replace />; // just logged out: go home, not to the login form
  const portal = roles?.some((r) => PORTAL_ROLES.includes(r));
  if (!user) return <Navigate to={portal ? '/staff/login' : '/login'} replace state={{ from: loc.pathname + loc.search }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user)} replace />;
  return children;
}
