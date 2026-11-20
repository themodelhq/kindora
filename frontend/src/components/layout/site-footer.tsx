import { Link } from 'react-router-dom';
import { LogoMark } from '@/components/logo';

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t bg-card">
      <div className="container flex flex-col gap-8 py-10 md:flex-row md:items-start md:justify-between">
        <div className="max-w-xs space-y-3">
          <div className="flex items-center gap-2">
            <LogoMark />
            <span className="text-lg font-extrabold tracking-tight">KINDORA</span>
          </div>
          <p className="text-sm text-muted-foreground">
            Goodness, in motion. A global crowdfunding platform built for transparency — every major fund movement is recorded on an auditable ledger.
          </p>
        </div>
        <nav className="grid grid-cols-2 gap-8 text-sm sm:grid-cols-3" aria-label="Footer">
          <div className="space-y-2">
            <p className="font-semibold">Platform</p>
            <Link to="/campaigns" className="block text-muted-foreground hover:text-primary">Discover causes</Link>
            <Link to="/start" className="block text-muted-foreground hover:text-primary">Start a campaign</Link>
            <Link to="/circles" className="block text-muted-foreground hover:text-primary">Giving circles</Link>
            <Link to="/organizations" className="block text-muted-foreground hover:text-primary">Organizations</Link>
          </div>
          <div className="space-y-2">
            <p className="font-semibold">Transparency</p>
            <Link to="/impact" className="block text-muted-foreground hover:text-primary">Public impact ledger</Link>
            <Link to="/how-it-works" className="block text-muted-foreground hover:text-primary">How it works</Link>
            <Link to="/about" className="block text-muted-foreground hover:text-primary">About</Link>
          </div>
          <div className="space-y-2">
            <p className="font-semibold">Legal</p>
            <Link to="/privacy" className="block text-muted-foreground hover:text-primary">Privacy</Link>
            <Link to="/terms" className="block text-muted-foreground hover:text-primary">Terms</Link>
          </div>
        </nav>
      </div>
      <div className="border-t py-4">
        <p className="container text-xs text-muted-foreground">
          © {new Date().getFullYear()} KINDORA. Payments are processed by licensed providers. KINDORA never stores your card details.
        </p>
      </div>
    </footer>
  );
}
