import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, HandCoins, Landmark, Settings, Wallet, Shield } from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV = {
  dashboard: [
    { to: '/dashboard', label: 'Overview', icon: LayoutDashboard, end: true },
    { to: '/dashboard/donations', label: 'My donations', icon: HandCoins },
    { to: '/dashboard/settings', label: 'Settings', icon: Settings },
  ],
  admin: [
    { to: '/admin', label: 'Console', icon: LayoutDashboard, end: true },
    { to: '/admin/campaigns', label: 'Campaigns', icon: HandCoins },
    { to: '/admin/users', label: 'Users', icon: Shield },
    { to: '/admin/transactions', label: 'Transactions', icon: Wallet },
    { to: '/admin/withdrawals', label: 'Withdrawals', icon: Wallet },
    { to: '/admin/financial', label: 'Financial centre', icon: Landmark },
    { to: '/admin/moderation', label: 'Moderation', icon: Shield },
  ],
};

export function DashboardShell({ variant }: { variant: 'dashboard' | 'admin' }) {
  const items = NAV[variant];
  return (
    <div className="container flex flex-col gap-6 py-6 lg:flex-row">
      <nav aria-label={variant === 'admin' ? 'Admin' : 'Dashboard'} className="lg:w-56 shrink-0">
        <ul className="flex gap-1 overflow-x-auto scrollbar-thin lg:flex-col">
          {items.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                    isActive ? 'bg-primary text-primary-foreground' : 'text-foreground/75 hover:bg-muted',
                  )
                }
              >
                <item.icon className="h-4 w-4" aria-hidden="true" />
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
