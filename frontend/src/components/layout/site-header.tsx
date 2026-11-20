import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { Menu, Search, LogOut, LayoutDashboard, Shield, Settings, HandCoins } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { Logo } from '@/components/logo';
import { useAuthStore } from '@/stores/auth-store';
import { useLogout } from '@/api/hooks';
import { initials } from '@/lib/utils';

const NAV = [
  { to: '/campaigns', label: 'Discover' },
  { to: '/impact', label: 'Impact' },
  { to: '/circles', label: 'Circles' },
  { to: '/organizations', label: 'Organizations' },
];

export function SiteHeader() {
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const logout = useLogout();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(`/campaigns?q=${encodeURIComponent(query)}`);
    setMobileOpen(false);
  };

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="container flex h-16 items-center gap-3">
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu" onClick={() => setMobileOpen(true)}>
          <Menu className="h-5 w-5" />
        </Button>
        <Logo />
        <nav className="hidden md:flex items-center gap-1" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-muted ${isActive ? 'text-primary' : 'text-foreground/80'}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <form onSubmit={onSearch} className="ml-auto hidden w-56 lg:block" role="search">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search causes…" className="pl-8" aria-label="Search campaigns" />
          </div>
        </form>
        <div className="ml-auto flex items-center gap-2 lg:ml-0">
          <Button asChild variant="accent" className="hidden sm:inline-flex">
            <Link to="/start"><HandCoins className="h-4 w-4" />Start a campaign</Link>
          </Button>
          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Account menu">
                  <Avatar>
                    <AvatarFallback>{initials(user.firstName, user.lastName)}</AvatarFallback>
                  </Avatar>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>
                  {user.firstName} {user.lastName}
                  <span className="block text-xs font-normal text-muted-foreground">{user.email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate('/dashboard')}><LayoutDashboard />Dashboard</DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate('/organizer')}><HandCoins />My campaigns</DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate('/dashboard/settings')}><Settings />Settings</DropdownMenuItem>
                {user.role === 'ADMIN' && (
                  <DropdownMenuItem onClick={() => navigate('/admin')}><Shield />Admin console</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => logout.mutate(undefined, { onSuccess: () => navigate('/') })}>
                  <LogOut />Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
                <Link to="/auth/login">Sign in</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link to="/auth/register">Join KINDORA</Link>
              </Button>
            </>
          )}
        </div>
      </div>

      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>KINDORA</DialogTitle>
          </DialogHeader>
          <nav className="flex flex-col gap-1" aria-label="Mobile">
            {NAV.map((item) => (
              <Link key={item.to} to={item.to} className="rounded-lg px-3 py-2.5 font-medium hover:bg-muted" onClick={() => setMobileOpen(false)}>
                {item.label}
              </Link>
            ))}
          </nav>
          <form onSubmit={onSearch} className="flex gap-2" role="search">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search causes…" aria-label="Search campaigns" />
            <Button type="submit" aria-label="Search"><Search className="h-4 w-4" /></Button>
          </form>
        </DialogContent>
      </Dialog>
    </header>
  );
}
