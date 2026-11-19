import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, setUnauthorizedHandler, tokenStore } from './api.js';
import { Loading } from './ui.jsx';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export const isStaffRole = (u) => u && (u.role === 'staff' || u.role === 'admin');

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);

  const clear = useCallback(() => {
    tokenStore.set(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(clear);
    if (!tokenStore.get()) {
      setReady(true);
      return;
    }
    api
      .get('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => tokenStore.set(null))
      .finally(() => setReady(true));
  }, [clear]);

  const value = useMemo(
    () => ({
      user,
      ready,
      loggedOut,
      async login(email, password, { staff = false } = {}) {
        const r = await api.post(staff ? '/auth/staff-login' : '/auth/login', { email, password });
        tokenStore.set(r.token);
        setLoggedOut(false);
        setUser(r.user);
        return r.user;
      },
      logout() {
        api.post('/auth/logout').catch(() => {});
        setLoggedOut(true);
        clear();
      },
      setUser,
    }),
    [user, ready, loggedOut, clear],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

/**
 * Route guard. Redirects with `replace` so the Back button cannot reopen a protected page after logout
 * (US1.3 criterion 3). `roles` limits who may enter (US9.1: customers cannot open staff pages).
 */
export function RequireAuth({ roles, children }) {
  const { user, ready, loggedOut } = useAuth();
  const loc = useLocation();
  if (!ready) return <Loading />;
  if (!user && loggedOut) return <Navigate to="/" replace />; // just logged out: go home, not to the login form
  const staffArea = roles?.includes('staff');
  if (!user) return <Navigate to={staffArea ? '/staff/login' : '/login'} replace state={{ from: loc.pathname + loc.search }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to={isStaffRole(user) ? '/staff' : '/dashboard'} replace />;
  return children;
}
