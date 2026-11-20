import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, HandCoins, Plus, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, StatCard } from '@/components/shared';
import { useMyCampaigns, useMyWithdrawals } from '@/api/hooks';
import { formatMoney, progressPercent } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { campaignStatusBadge, withdrawalStatusBadge } from '@/lib/status';
import type { CampaignSummary } from '@/types/api';

function CampaignRow({ campaign }: { campaign: CampaignSummary }) {
  const badge = campaignStatusBadge(campaign.status);
  const pct = progressPercent(campaign.raisedAmount, campaign.targetAmount);
  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate font-semibold">
              <Link to={`/organizer/campaigns/${campaign.id}`} className="hover:text-primary hover:underline">
                {campaign.title}
              </Link>
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Created {formatDate(campaign.createdAt)}
              {campaign.category ? ` · ${campaign.category.name}` : ''}
            </p>
          </div>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="font-bold text-primary">{formatMoney(campaign.raisedAmount, campaign.currency)}</span>
            <span className="text-xs text-muted-foreground">
              {pct}% of {formatMoney(campaign.targetAmount, campaign.currency)}
            </span>
          </div>
          <Progress value={pct} aria-label={`${pct}% funded`} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <p className="text-xs text-muted-foreground">
            {campaign.donorCount.toLocaleString()} donors
            {campaign.viewCount ? ` · ${campaign.viewCount.toLocaleString()} views` : ''}
          </p>
          <div className="flex gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to={`/campaigns/${campaign.slug}`}>View public page</Link>
            </Button>
            <Button asChild size="sm">
              <Link to={`/organizer/campaigns/${campaign.id}`}>Manage</Link>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function OrganizerIndexPage() {
  const campaignsQuery = useMyCampaigns();
  const withdrawalsQuery = useMyWithdrawals();

  const campaigns = useMemo(() => campaignsQuery.data?.items ?? [], [campaignsQuery.data]);
  const stats = useMemo(() => {
    let raised = 0;
    let currency = 'NGN';
    let active = 0;
    for (const campaign of campaigns) {
      raised += Number(campaign.raisedAmount) || 0;
      currency = campaign.currency || currency;
      if (campaign.status === 'ACTIVE') active += 1;
    }
    return { raised, currency, active };
  }, [campaigns]);

  const withdrawals = (withdrawalsQuery.data?.items ?? []).slice(0, 3);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">Organizer</h1>
          <p className="mt-1 text-sm text-muted-foreground">Your campaigns, fundraising performance, and payouts.</p>
        </div>
        <Button asChild>
          <Link to="/start">
            <Plus aria-hidden="true" />
            New campaign
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Total raised"
          value={formatMoney(stats.raised, stats.currency)}
          hint="Across all your campaigns"
        />
        <StatCard label="Active campaigns" value={String(stats.active)} hint="Live and accepting donations" />
        <StatCard label="All campaigns" value={String(campaigns.length)} hint="Drafts, live, and closed" />
      </div>

      <section className="space-y-3" aria-labelledby="my-campaigns-heading">
        <h2 id="my-campaigns-heading" className="text-lg font-bold">
          My campaigns
        </h2>
        {campaignsQuery.isLoading ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="space-y-4 p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-2">
                      <Skeleton className="h-5 w-56" />
                      <Skeleton className="h-3 w-36" />
                    </div>
                    <Skeleton className="h-5 w-24 rounded-full" />
                  </div>
                  <Skeleton className="h-2.5 w-full rounded-full" />
                  <Skeleton className="h-9 w-40" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : campaigns.length === 0 ? (
          <EmptyState
            icon={HandCoins}
            title="No campaigns yet"
            description="Start your first campaign and KINDORA will guide you through the story, target, and submission steps."
            action={
              <Button asChild variant="accent">
                <Link to="/start">Start a campaign</Link>
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {campaigns.map((campaign) => (
              <CampaignRow key={campaign.id} campaign={campaign} />
            ))}
          </div>
        )}
      </section>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Withdrawals</CardTitle>
            <CardDescription>Latest payout requests on your campaigns.</CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/organizer/new-withdrawal">
              <Wallet aria-hidden="true" />
              Request withdrawal
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {withdrawalsQuery.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between gap-3">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-5 w-20 rounded-full" />
                </div>
              ))}
            </div>
          ) : withdrawals.length === 0 ? (
            <p className="rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
              No withdrawal requests yet. Once donations settle you can request a payout from your campaign balance.
            </p>
          ) : (
            <ul className="divide-y">
              {withdrawals.map((withdrawal) => {
                const badge = withdrawalStatusBadge(withdrawal.status);
                return (
                  <li key={withdrawal.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {withdrawal.campaign?.title ?? withdrawal.publicRef}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(withdrawal.createdAt)} · {withdrawal.publicRef}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-bold">{formatMoney(withdrawal.amount, withdrawal.currency)}</span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <Link
            to="/organizer/new-withdrawal"
            className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
          >
            Manage payouts
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
