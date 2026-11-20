import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, HandCoins, MailCheck, Plus, Store, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, StatCard } from '@/components/shared';
import { useMyDonations, useMyNotifications } from '@/api/hooks';
import { useAuthStore } from '@/stores/auth-store';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { donationStatusBadge } from '@/lib/status';

function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function DashboardOverviewPage() {
  const user = useAuthStore((s) => s.user);
  const donationsQuery = useMyDonations(1);
  const notificationsQuery = useMyNotifications();

  const { totalDonatedMinor, donatedCurrency, supportedCount, recent } = useMemo(() => {
    const items = donationsQuery.data?.items ?? [];
    let total = 0;
    let currency = 'NGN';
    const slugs = new Set<string>();
    for (const donation of items) {
      if (donation.campaign?.slug) slugs.add(donation.campaign.slug);
      if (donation.status === 'SUCCEEDED') {
        total += Number(donation.amount) || 0;
        currency = donation.currency || currency;
      }
    }
    return {
      totalDonatedMinor: total,
      donatedCurrency: currency,
      supportedCount: slugs.size,
      recent: items.slice(0, 5),
    };
  }, [donationsQuery.data]);

  const unreadNotifications = (notificationsQuery.data?.items ?? []).filter((n) => !n.readAt).length;
  const donationsLoading = donationsQuery.isLoading;
  const showVerifyNotice = Boolean(user && user.emailVerified === false);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">
          {greetingForHour(new Date().getHours())}
          {user?.firstName ? `, ${user.firstName}` : ''}!
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Here is a snapshot of your giving on KINDORA.</p>
      </div>

      {showVerifyNotice && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="flex items-start gap-3">
              <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
              <div>
                <p className="font-semibold text-amber-900">Verify your email address</p>
                <p className="text-sm text-amber-800">
                  Confirm your email to secure your account and receive receipts and campaign updates.
                </p>
              </div>
            </div>
            <Button asChild variant="outline" className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100">
              <Link to="/auth/verify">Verify now</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {donationsLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="space-y-3 p-5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-7 w-28" />
                <Skeleton className="h-3 w-32" />
              </CardContent>
            </Card>
          ))
        ) : (
          <>
            <StatCard
              label="Total donated"
              value={formatMoney(totalDonatedMinor, donatedCurrency)}
              hint="Successful gifts"
            />
            <StatCard label="Campaigns supported" value={String(supportedCount)} hint="Causes you backed" />
            <StatCard label="Unread notifications" value={String(unreadNotifications)} hint="New alerts for you" />
          </>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="space-y-1.5">
              <CardTitle>Recent donations</CardTitle>
              <CardDescription>Your latest gifts across KINDORA.</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/dashboard/donations">
                View all
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {donationsLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between gap-3">
                    <div className="space-y-1.5">
                      <Skeleton className="h-4 w-44" />
                      <Skeleton className="h-3 w-28" />
                    </div>
                    <Skeleton className="h-4 w-16" />
                  </div>
                ))}
              </div>
            ) : recent.length === 0 ? (
              <EmptyState
                icon={HandCoins}
                title="No donations yet"
                description="When you give to a campaign, your gifts and receipts appear here."
                action={
                  <Button asChild variant="accent">
                    <Link to="/campaigns">Browse campaigns</Link>
                  </Button>
                }
              />
            ) : (
              <ul className="divide-y">
                {recent.map((donation) => {
                  const badge = donationStatusBadge(donation.status);
                  return (
                    <li key={donation.publicRef} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {donation.campaign ? (
                            <Link
                              to={`/campaigns/${donation.campaign.slug}`}
                              className="hover:text-primary hover:underline"
                            >
                              {donation.campaign.title}
                            </Link>
                          ) : (
                            'Donation'
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">{formatDate(donation.createdAt)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2.5">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                        <span className="text-sm font-bold text-primary">
                          {formatMoney(donation.amount, donation.currency)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Quick actions</CardTitle>
              <CardDescription>Jump straight into what matters.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Button asChild variant="outline" className="h-auto justify-start gap-3 py-3.5 text-left">
                <Link to="/start">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100">
                    <Plus className="h-4 w-4 text-primary" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block font-semibold">Start a campaign</span>
                    <span className="block text-xs font-normal text-muted-foreground">Raise funds for a cause</span>
                  </span>
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-auto justify-start gap-3 py-3.5 text-left">
                <Link to="/organizer">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100">
                    <Store className="h-4 w-4 text-accent-foreground" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block font-semibold">Organizer dashboard</span>
                    <span className="block text-xs font-normal text-muted-foreground">Manage campaigns and payouts</span>
                  </span>
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-4 p-5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-100">
                <Wallet className="h-5 w-5 text-primary" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="font-semibold">Every gift is traceable</p>
                <p className="text-sm text-muted-foreground">
                  Donations post to a public ledger, so you can see exactly where money goes.
                </p>
                <Link to="/impact" className="mt-1 inline-block text-sm font-semibold text-primary hover:underline">
                  See live impact
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
