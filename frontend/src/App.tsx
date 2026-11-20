import { Suspense, lazy } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { RootLayout } from '@/components/layout/root-layout';
import { RequireAuth, RequireRole } from '@/components/layout/guards';
import { DashboardShell } from '@/components/layout/dashboard-shell';
import { Toaster } from '@/components/ui/sonner';
import { Loader2 } from 'lucide-react';

const load = (fn: () => Promise<{ default: React.ComponentType }>) => {
  const C = lazy(fn);
  return (
    <Suspense fallback={<PageFallback />}>
      <C />
    </Suspense>
  );
};

function PageFallback() {
  return (
    <div className="flex min-h-[50dvh] items-center justify-center" role="status" aria-label="Loading">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: '/', element: load(() => import('@/pages/home')) },
      { path: '/campaigns', element: load(() => import('@/pages/campaigns/browse')) },
      { path: '/campaigns/:slug', element: load(() => import('@/pages/campaigns/detail')) },
      { path: '/donate/:slug', element: load(() => import('@/pages/donate/checkout')) },
      { path: '/donate/status', element: load(() => import('@/pages/donate/status')) },
      { path: '/impact', element: load(() => import('@/pages/impact')) },
      { path: '/circles', element: load(() => import('@/pages/circles/index')) },
      { path: '/circles/:slug', element: load(() => import('@/pages/circles/detail')) },
      { path: '/organizations', element: load(() => import('@/pages/organizations/index')) },
      { path: '/organizations/:slug', element: load(() => import('@/pages/organizations/detail')) },
      { path: '/about', element: load(() => import('@/pages/static/about')) },
      { path: '/how-it-works', element: load(() => import('@/pages/static/how-it-works')) },
      { path: '/privacy', element: load(() => import('@/pages/static/privacy')) },
      { path: '/terms', element: load(() => import('@/pages/static/terms')) },
      { path: '/auth/login', element: load(() => import('@/pages/auth/login')) },
      { path: '/auth/register', element: load(() => import('@/pages/auth/register')) },
      { path: '/auth/verify', element: load(() => import('@/pages/auth/verify')) },
      { path: '/auth/forgot', element: load(() => import('@/pages/auth/forgot')) },
      { path: '/auth/reset', element: load(() => import('@/pages/auth/reset')) },

      // Authenticated user + organizer area
      {
        element: <RequireAuth />,
        children: [
          { path: '/start', element: load(() => import('@/pages/create/wizard')) },
          { path: '/organizer/new-withdrawal', element: load(() => import('@/pages/organizer/withdraw')) },
          {
            element: <DashboardShell variant="dashboard" />,
            children: [
              { path: '/dashboard', element: load(() => import('@/pages/dashboard/overview')) },
              { path: '/dashboard/donations', element: load(() => import('@/pages/dashboard/donations')) },
              { path: '/dashboard/settings', element: load(() => import('@/pages/dashboard/settings')) },
              { path: '/organizer', element: load(() => import('@/pages/organizer/index')) },
              { path: '/organizer/campaigns/:id', element: load(() => import('@/pages/organizer/manage')) },
            ],
          },
        ],
      },

      // Admin console
      {
        element: <RequireRole role="ADMIN" />,
        children: [
          {
            element: <DashboardShell variant="admin" />,
            children: [
              { path: '/admin', element: load(() => import('@/pages/admin/index')) },
              { path: '/admin/campaigns', element: load(() => import('@/pages/admin/campaigns')) },
              { path: '/admin/users', element: load(() => import('@/pages/admin/users')) },
              { path: '/admin/transactions', element: load(() => import('@/pages/admin/transactions')) },
              { path: '/admin/withdrawals', element: load(() => import('@/pages/admin/withdrawals')) },
              { path: '/admin/moderation', element: load(() => import('@/pages/admin/moderation')) },
              { path: '/admin/financial', element: load(() => import('@/pages/admin/financial')) },
              { path: '/admin/financial/reconciliation', element: load(() => import('@/pages/admin/financial-reconciliation')) },
            ],
          },
        ],
      },

      { path: '*', element: load(() => import('@/pages/not-found')) },
    ],
  },
]);

export function App() {
  return (
    <>
      <RouterProvider router={router} />
      <Toaster position="top-center" richColors />
    </>
  );
}
