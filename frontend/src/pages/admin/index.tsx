import { Link } from 'react-router-dom';
import { ArrowRight, HandCoins, HeartHandshake, Shield, ShieldAlert, Users, Wallet } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, StatCard } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { useAdminStats } from '@/api/hooks';
import { formatMoney } from '@/lib/money';

const QUICK_ACTIONS = [
  {
    to: '/admin/campaigns',
    icon: HandCoins,
    title: 'Campaign review',
    description: 'Approve, reject, suspend or feature fundraisers and clear the KYC queue.',
  },
  {
    to: '/admin/withdrawals',
    icon: Wallet,
    title: 'Withdrawals',
    description: 'Review payout requests, approve them and mark transfers as paid.',
  },
  {
    to: '/admin/moderation',
    icon: Shield,
    title: 'Moderation & fraud',
    description: 'Resolve reported cases and dismiss fraud signals raised by detection rules.',
  },
] as const;

export default function AdminIndexPage() {
  const { data: stats, isLoading, isError, refetch } = useAdminStats();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Admin console</h1>
        <p className="text-sm text-muted-foreground">
          Platform health at a glance. Review queues below need attention.
        </p>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
      ) : isError || !stats ? (
        <EmptyState
          icon={ShieldAlert}
          title="Could not load stats"
          description="Something went wrong while fetching admin statistics."
          action={<Button onClick={() => void refetch()}>Try again</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <StatCard label="Users" value={stats.users.toLocaleString()} hint="Registered accounts" />
          <StatCard label="Campaigns" value={stats.campaigns.toLocaleString()} hint="All fundraisers on the platform" />
          <StatCard
            label="Pending review"
            value={stats.campaignsPending.toLocaleString()}
            hint="Campaigns waiting for approval"
            tone="accent"
          />
          <StatCard
            label="Donations total"
            value={formatMoney(stats.donationsTotalMinor, 'NGN')}
            hint={`${stats.donationsCount.toLocaleString()} donations processed`}
          />
          <StatCard
            label="Withdrawals pending"
            value={stats.withdrawalsPending.toLocaleString()}
            hint="Payout requests awaiting action"
            tone="accent"
          />
          <StatCard
            label="Open moderation cases"
            value={stats.moderationOpen.toLocaleString()}
            hint="Reports to resolve"
            tone="accent"
          />
          <StatCard
            label="Open fraud signals"
            value={stats.fraudOpen.toLocaleString()}
            hint="Raised by detection rules"
            tone="accent"
          />
        </div>
      )}

      {/* Quick actions */}
      <section aria-label="Quick actions" className="space-y-3">
        <h2 className="text-lg font-semibold">Quick actions</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {QUICK_ACTIONS.map((action) => (
            <Link
              key={action.to}
              to={action.to}
              className="group block focus-visible:outline-none"
              aria-label={action.title}
            >
              <Card className="h-full transition-all group-hover:-translate-y-0.5 group-hover:shadow-lift group-focus-visible:ring-2 group-focus-visible:ring-ring">
                <CardContent className="flex h-full flex-col gap-3 p-5">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                    <action.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <h3 className="font-semibold group-hover:text-primary">{action.title}</h3>
                  <p className="text-sm text-muted-foreground">{action.description}</p>
                  <span className="mt-auto inline-flex items-center gap-1 pt-2 text-sm font-semibold text-primary">
                    Open
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      {/* System status */}
      <Card className="rounded-2xl shadow-soft">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <HeartHandshake className="h-5 w-5 text-primary" aria-hidden="true" />
            System status
          </CardTitle>
          <CardDescription>Where to check platform health.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Service health lives at the API endpoint <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">/api/v1/health</code>{' '}
            and is monitored separately from this console.
          </p>
          <p>
            If pages here fail to load, check that endpoint first, then review recent deploys before digging into
            individual queues.
          </p>
        </CardContent>
      </Card>

      {/* More tools */}
      <div className="grid gap-4 md:grid-cols-2">
        <Link to="/admin/users" className="group block focus-visible:outline-none" aria-label="User management">
          <Card className="transition-all group-hover:shadow-lift">
            <CardContent className="flex items-center gap-4 p-5">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-foreground">
                <Users className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3 className="font-semibold group-hover:text-primary">User management</h3>
                <p className="text-sm text-muted-foreground">Search accounts and suspend or reactivate users.</p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link to="/admin/transactions" className="group block focus-visible:outline-none" aria-label="Transactions ledger">
          <Card className="transition-all group-hover:shadow-lift">
            <CardContent className="flex items-center gap-4 p-5">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-foreground">
                <Wallet className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3 className="font-semibold group-hover:text-primary">Transactions & reconciliation</h3>
                <p className="text-sm text-muted-foreground">Inspect the ledger, issue refunds and run reconciliation.</p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
