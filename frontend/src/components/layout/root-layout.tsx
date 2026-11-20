import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { SiteHeader } from './site-header';
import { SiteFooter } from './site-footer';
import { isDemoMode } from '@/lib/demo/adapter';
import { useAuthStore } from '@/stores/auth-store';

export function RootLayout() {
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const location = useLocation();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className="flex min-h-dvh flex-col">
      {isDemoMode() && (
        <div className="bg-accent px-4 py-1.5 text-center text-xs font-semibold text-accent-foreground" role="status">
          Demo preview mode — sample content and simulated donations. Production deployments connect to the KINDORA API.
        </div>
      )}
      <SiteHeader />
      <main className="flex-1">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}
