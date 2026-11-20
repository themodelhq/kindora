import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth-store';
import type { UserRole } from '@/types/api';

function BootGate({ children }: { children: React.ReactNode }) {
  const bootstrapped = useAuthStore((s) => s.bootstrapped);
  if (!bootstrapped) {
    // Session bootstrap (cookie refresh + profile fetch) in progress:
    // never redirect to login before it resolves — that race logged
    // deep-linking users out on first paint.
    return null;
  }
  return <>{children}</>;
}

export function RequireAuth() {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  return (
    <BootGate>
      {user ? <Outlet /> : <Navigate to="/auth/login" state={{ from: location.pathname }} replace />}
    </BootGate>
  );
}

export function RequireRole({ role }: { role: UserRole }) {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  return (
    <BootGate>
      {!user ? (
        <Navigate to="/auth/login" state={{ from: location.pathname }} replace />
      ) : user.role !== role && user.role !== 'ADMIN' ? (
        <Navigate to="/" replace />
      ) : (
        <Outlet />
      )}
    </BootGate>
  );
}
