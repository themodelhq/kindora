import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowRight, BadgeCheck, ChevronRight, Clock, Copy, Flag, HandCoins, Heart, Link2, MapPin,
  Share2, Users,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/shared';
import { CATEGORY_META } from '@/components/campaign-category';
import {
  useCampaign, useCampaignDonors, useCampaignLedger, useCampaignUpdates, useReport,
} from '@/api/hooks';
import { formatMoney, progressPercent } from '@/lib/money';
import { daysUntil, formatDate, initials, relativeTime, truncate } from '@/lib/utils';

type TxBadgeVariant = 'default' | 'accent' | 'secondary' | 'success' | 'warning' | 'destructive' | 'muted';

const TX_BADGE: Record<string, TxBadgeVariant> = {
  DONATION: 'success',
  TIP: 'accent',
  WITHDRAWAL: 'muted',
  MATCH: 'default',
  REFUND: 'destructive',
};

function LedgerTypeBadge({ type }: { type: string }) {
  return <Badge variant={TX_BADGE[type] ?? 'muted'}>{type}</Badge>;
}

export default function CampaignDetailPage() {
  const params = useParams();
  const slug = params.slug ?? '';

  const [donorPage, setDonorPage] = useState(1);

  const campaign = useCampaign(slug);
  const donors = useCampaignDonors(slug, donorPage);
  const updates = useCampaignUpdates(slug);
  const ledger = useCampaignLedger(slug);
  const report = useReport();

  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState('');

  const c = campaign.data;
  const pct = c ? progressPercent(c.raisedAmount, c.targetAmount) : 0;
  const days = daysUntil(c?.deadline);
  const meta = c?.category ? CATEGORY_META[c.category.slug] : undefined;
  const shareUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/campaigns/${slug}`;
  const shareText = c ? `Support "${c.title}" on KINDORA: ${shareUrl}` : shareUrl;

  const shareWhatsApp = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank', 'noopener,noreferrer');
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success('Link copied to clipboard');
    } catch {
      toast.error('Could not copy the link. Please copy it from the address bar.');
    }
  };

  const nativeShare = async () => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: c?.title ?? 'KINDORA campaign', text: shareText, url: shareUrl });
      } catch {
        /* user dismissed the share sheet */
      }
    } else {
      void copyLink();
    }
  };

  const submitReport = async () => {
    if (!c) return;
    if (reportText.trim().length < 10) {
      toast.error('Please describe the problem in at least 10 characters.');
      return;
    }
    try {
      await report.mutateAsync({ entityType: 'CAMPAIGN', entityId: c.id, description: reportText.trim() });
      toast.success('Thank you. Our trust and safety team will review this campaign.');
      setReportOpen(false);
      setReportText('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not submit the report. Please try again.');
    }
  };

  /* ---------- Loading ---------- */
  if (campaign.isLoading) {
    return (
      <div className="container space-y-6 py-8 lg:py-12" aria-busy="true">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-10 w-3/4 max-w-xl" />
        <Skeleton className="h-72 w-full rounded-2xl" />
        <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
          <div className="space-y-4">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-5/6" />
            <Skeleton className="h-5 w-2/3" />
          </div>
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      </div>
    );
  }

  /* ---------- Error / not found ---------- */
  if (campaign.isError || !c) {
    return (
      <div className="container py-16">
        <EmptyState
          icon={Flag}
          title="Campaign not available"
          description="This campaign may have been removed, or the link is incorrect. Browse verified causes to find another way to help."
          action={
            <Button asChild>
              <Link to="/campaigns">Explore campaigns</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const organizerName = c.createdBy ? `${c.createdBy.firstName} ${c.createdBy.lastName}`.trim() : 'KINDORA organizer';
  const donorItems = donors.data?.items ?? [];
  const donorTotal = donors.data?.total ?? 0;
  const donorPageSize = Math.max(donorItems.length, 1);
  const donorTotalPages = Math.max(1, Math.ceil(donorTotal / donorPageSize));
  const ledgerOk = !ledger.isError && Boolean(ledger.data);

  return (
    <div className="pb-20 lg:pb-0">
      <div className="container py-6 lg:py-10">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="mb-5 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/" className="hover:text-primary">Home</Link>
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          <Link to="/campaigns" className="hover:text-primary">Campaigns</Link>
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="truncate font-medium text-foreground" aria-current="page">
            {truncate(c.title, 48)}
          </span>
        </nav>

        {/* Title row */}
        <header className="mb-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{meta?.name ?? c.category?.name ?? 'Cause'}</Badge>
            {c.isFeatured && <Badge variant="accent">Featured</Badge>}
            {c.country && (
              <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                {[c.city, c.country].filter(Boolean).join(', ')}
              </span>
            )}
          </div>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">{c.title}</h1>
          {c.excerpt && <p className="mt-3 max-w-3xl text-lg text-muted-foreground">{c.excerpt}</p>}
        </header>

        {/* Cover */}
        {c.coverImageUrl ? (
          <img
            src={c.coverImageUrl}
            alt={`Cover image for ${c.title}`}
            className="mb-8 h-64 w-full rounded-2xl object-cover shadow-soft sm:h-80 lg:h-96"
          />
        ) : (
          <div
            className="mb-8 flex h-56 w-full items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 via-teal-600 to-emerald-700 shadow-soft sm:h-72 lg:h-80"
            role="img"
            aria-label={`${meta?.name ?? 'Cause'} illustration for ${c.title}`}
          >
            {meta && <meta.icon className="h-24 w-24 text-white/30" aria-hidden="true" />}
          </div>
        )}

        {/* Matching pool banner */}
        {c.matchingPools.length > 0 && (
          <Card className="mb-8 border-accent/40 bg-accent/10">
            <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent/30" aria-hidden="true">
                <HandCoins className="h-5 w-5 text-accent-foreground" />
              </span>
              <div className="flex-1">
                <p className="font-bold">
                  {c.matchingPools[0].name} — donations matched {c.matchingPools[0].matchRatio}%
                </p>
                <p className="text-sm text-muted-foreground">
                  A sponsor pool multiplies your gift while funds last.{' '}
                  {formatMoney(
                    Math.max(0, Number(c.matchingPools[0].totalCommitted) - Number(c.matchingPools[0].matchedAmount)),
                    c.currency,
                  )}{' '}
                  of match funds remains, recorded on the public ledger.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Main grid */}
        <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
          {/* Story + tabs */}
          <div className="min-w-0">
            <Tabs defaultValue="story">
              <TabsList aria-label="Campaign sections">
                <TabsTrigger value="story">Story</TabsTrigger>
                <TabsTrigger value="updates">Updates{updates.data ? ` (${updates.data.total})` : ''}</TabsTrigger>
                <TabsTrigger value="donors">Donors</TabsTrigger>
                {ledgerOk && <TabsTrigger value="transparency">Transparency</TabsTrigger>}
              </TabsList>

              {/* Story */}
              <TabsContent value="story">
                <Card>
                  <CardContent className="p-6 lg:p-8">
                    <div className="whitespace-pre-wrap text-base leading-7 text-foreground/90">
                      {c.story}
                    </div>
                    {c.beneficiary && (
                      <>
                        <Separator className="my-6" />
                        <p className="text-sm text-muted-foreground">
                          <span className="font-semibold text-foreground">Beneficiary:</span> {c.beneficiary.name}
                        </p>
                      </>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Updates */}
              <TabsContent value="updates">
                {updates.isLoading ? (
                  <div className="space-y-4">
                    <Skeleton className="h-24 w-full rounded-2xl" />
                    <Skeleton className="h-24 w-full rounded-2xl" />
                  </div>
                ) : updates.isError ? (
                  <EmptyState
                    icon={Clock}
                    title="Updates unavailable"
                    description="We could not load campaign updates right now. Please try again later."
                  />
                ) : updates.data?.items.length ? (
                  <ol className="space-y-6 border-l-2 border-border pl-6">
                    {updates.data.items.map((u) => (
                      <li key={u.id} className="relative">
                        <span
                          className="absolute -left-[31px] top-1.5 h-3 w-3 rounded-full bg-primary ring-4 ring-primary/10"
                          aria-hidden="true"
                        />
                        <Card>
                          <CardContent className="p-5">
                            <h3 className="font-bold">{u.title}</h3>
                            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                              {u.body}
                            </p>
                            <p className="mt-3 text-xs text-muted-foreground">
                              {u.author.firstName} {u.author.lastName} · {relativeTime(u.createdAt)}
                            </p>
                          </CardContent>
                        </Card>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <EmptyState
                    icon={Clock}
                    title="No updates yet"
                    description="The organizer has not posted an update yet. Donors receive a notification when they do."
                  />
                )}
              </TabsContent>

              {/* Donors */}
              <TabsContent value="donors">
                {donors.isLoading ? (
                  <div className="space-y-3">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="h-16 w-full rounded-2xl" />
                    ))}
                  </div>
                ) : donors.isError ? (
                  <EmptyState
                    icon={Users}
                    title="Donor list unavailable"
                    description="We could not load donations for this campaign right now. Please try again later."
                  />
                ) : donorItems.length === 0 ? (
                  <EmptyState
                    icon={Heart}
                    title="No donations yet"
                    description="Be the first to support this cause — every gift is recorded on the public ledger."
                    action={
                      <Button asChild>
                        <Link to={`/donate/${slug}`}>Donate now</Link>
                      </Button>
                    }
                  />
                ) : (
                  <div className="space-y-3">
                    <ul className="space-y-3">
                      {donorItems.map((d) => (
                        <li key={d.publicRef}>
                          <Card>
                            <CardContent className="flex items-start gap-4 p-4 sm:p-5">
                              <Avatar className="h-11 w-11">
                                <AvatarFallback>
                                  {d.isAnonymous ? (
                                    <Heart className="h-4 w-4 text-primary" aria-hidden="true" />
                                  ) : (
                                    d.donorName.trim().charAt(0).toUpperCase() || '?'
                                  )}
                                </AvatarFallback>
                              </Avatar>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                  <p className="font-semibold">
                                    {d.isAnonymous ? 'Anonymous donor' : d.donorName}
                                  </p>
                                  <p className="font-bold text-primary">
                                    {formatMoney(d.amount, d.currency)}
                                    {Number(d.matchedAmount) > 0 && (
                                      <span className="ml-1 text-xs font-semibold text-accent-foreground">
                                        +{formatMoney(d.matchedAmount, d.currency)} matched
                                      </span>
                                    )}
                                  </p>
                                </div>
                                {d.message && (
                                  <p className="mt-1.5 text-sm text-muted-foreground">“{d.message}”</p>
                                )}
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {relativeTime(d.createdAt)} · Ref {d.publicRef}
                                </p>
                              </div>
                            </CardContent>
                          </Card>
                        </li>
                      ))}
                    </ul>
                    {donorTotalPages > 1 && (
                      <nav className="flex items-center justify-center gap-3 pt-2" aria-label="Donor list pagination">
                        <Button
                          variant="outline"
                          onClick={() => setDonorPage((p) => Math.max(1, p - 1))}
                          disabled={donorPage <= 1}
                          aria-label="Previous donors"
                        >
                          Previous
                        </Button>
                        <span className="text-sm text-muted-foreground">
                          Page {donorPage} of {donorTotalPages}
                        </span>
                        <Button
                          variant="outline"
                          onClick={() => setDonorPage((p) => Math.min(donorTotalPages, p + 1))}
                          disabled={donorPage >= donorTotalPages}
                          aria-label="More donors"
                        >
                          Next
                        </Button>
                      </nav>
                    )}
                  </div>
                )}
              </TabsContent>

              {/* Transparency */}
              {ledgerOk && ledger.data && (
                <TabsContent value="transparency">
                  <div className="space-y-4">
                    <Card>
                      <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Ledger balance held for this campaign
                          </p>
                          <p className="mt-1 text-2xl font-extrabold text-primary">
                            {formatMoney(ledger.data.balanceMinor, ledger.data.campaign.currency ?? c.currency)}
                          </p>
                        </div>
                        <Button asChild variant="outline">
                          <Link to="/impact">
                            Full public ledger
                            <ArrowRight className="h-4 w-4" aria-hidden="true" />
                          </Link>
                        </Button>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardContent className="divide-y p-0">
                        {ledger.data.entries.map((entry, i) => (
                          <div key={`${entry.transaction.type}-${entry.transaction.postedAt}-${i}`} className="flex flex-wrap items-center gap-3 p-4">
                            <LedgerTypeBadge type={entry.transaction.type} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">
                                {entry.transaction.description ?? `${entry.transaction.type} entry`}
                              </p>
                              <p className="text-xs text-muted-foreground">{formatDate(entry.transaction.postedAt)}</p>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge
                                variant="outline"
                                className={
                                  entry.direction === 'CREDIT'
                                    ? 'border-emerald-600/30 text-emerald-700'
                                    : 'border-destructive/30 text-destructive'
                                }
                              >
                                {entry.direction} {formatMoney(entry.amount, entry.currency)}
                              </Badge>
                            </div>
                          </div>
                        ))}
                      </CardContent>
                    </Card>

                    {ledger.data.paidWithdrawals.length > 0 && (
                      <Card>
                        <CardContent className="p-5">
                          <h3 className="font-bold">Paid withdrawals</h3>
                          <ul className="mt-3 space-y-2">
                            {ledger.data.paidWithdrawals.map((w) => (
                              <li key={w.publicRef} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                <span className="font-medium">{w.publicRef}</span>
                                <span className="text-muted-foreground">{formatDate(w.paidAt)}</span>
                                <span className="font-bold text-primary">{formatMoney(w.netAmount, c.currency)}</span>
                              </li>
                            ))}
                          </ul>
                        </CardContent>
                      </Card>
                    )}

                    <p className="text-xs text-muted-foreground">
                      Every entry above is part of KINDORA&apos;s double-entry ledger. Debits and credits always balance.
                    </p>
                  </div>
                </TabsContent>
              )}
            </Tabs>
          </div>

          {/* Right rail */}
          <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start" aria-label="Donation panel">
            <Card>
              <CardContent className="space-y-5 p-6">
                <div>
                  <p className="text-3xl font-extrabold text-primary">
                    {formatMoney(c.raisedAmount, c.currency)}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    raised of {formatMoney(c.targetAmount, c.currency)} goal
                  </p>
                </div>
                <Progress value={pct} aria-label={`${pct}% of goal reached`} />
                <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <Users className="h-4 w-4" aria-hidden="true" />
                    {c.donorCount.toLocaleString()} donor{c.donorCount === 1 ? '' : 's'}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Clock className="h-4 w-4" aria-hidden="true" />
                    {days === null ? 'No deadline' : days > 0 ? `${days} day${days === 1 ? '' : 's'} left` : 'Fundraising ended'}
                  </span>
                </div>
                <Button asChild size="lg" className="w-full text-base">
                  <Link to={`/donate/${slug}`}>Donate now</Link>
                </Button>

                <Separator />

                <div className="grid grid-cols-3 gap-2" aria-label="Share this campaign">
                  <Button variant="outline" size="sm" className="h-11" onClick={shareWhatsApp}>
                    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
                      <path d="M12 2a10 10 0 0 0-8.66 15L2 22l5.16-1.35A10 10 0 1 0 12 2Zm5.46 14.2c-.23.65-1.34 1.24-1.87 1.29-.53.05-1.02.23-3.44-.72-2.91-1.15-4.72-4.13-4.86-4.32-.14-.19-1.15-1.53-1.15-2.92 0-1.39.72-2.07.98-2.35.26-.28.57-.35.76-.35.19 0 .38 0 .55.01.18.01.42-.07.65.5.24.57.81 1.97.88 2.11.07.14.12.31.02.5-.1.19-.15.3-.29.47-.14.17-.3.38-.43.51-.14.14-.29.3-.12.58.17.28.75 1.23 1.6 1.99 1.1.98 2.03 1.28 2.31 1.43.28.14.44.12.61-.07.17-.19.71-.83.9-1.11.19-.28.38-.23.64-.14.26.1 1.66.78 1.94.92.28.14.47.21.54.33.07.12.07.7-.16 1.35Z" />
                    </svg>
                    <span className="sr-only sm:not-sr-only">WhatsApp</span>
                  </Button>
                  <Button variant="outline" size="sm" className="h-11" onClick={() => void copyLink()}>
                    <Link2 className="h-4 w-4" aria-hidden="true" />
                    <span className="sr-only sm:not-sr-only">Copy link</span>
                  </Button>
                  <Button variant="outline" size="sm" className="h-11" onClick={() => void nativeShare()}>
                    <Share2 className="h-4 w-4" aria-hidden="true" />
                    <span className="sr-only sm:not-sr-only">Share</span>
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-4 p-6">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Organizer</h2>
                <div className="flex items-center gap-3">
                  <Avatar className="h-11 w-11">
                    <AvatarFallback>{initials(c.createdBy?.firstName, c.createdBy?.lastName)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{organizerName}</p>
                    <p className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                      <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      Verified organizer
                    </p>
                  </div>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Identity confirmed by KINDORA review before this campaign was published.
                </p>
                <Button variant="ghost" size="sm" className="h-11 text-muted-foreground" onClick={() => setReportOpen(true)}>
                  <Flag className="h-4 w-4" aria-hidden="true" />
                  Report this campaign
                </Button>
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>

      {/* Mobile sticky donate bar */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur lg:hidden">
        <div className="container flex items-center justify-between gap-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-primary">{formatMoney(c.raisedAmount, c.currency)} raised</p>
            <p className="text-xs text-muted-foreground">
              {pct}% · {c.donorCount.toLocaleString()} donors
            </p>
          </div>
          <Button asChild className="min-w-32 shrink-0">
            <Link to={`/donate/${slug}`}>Donate</Link>
          </Button>
        </div>
      </div>

      {/* Report dialog */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report this campaign</DialogTitle>
            <DialogDescription>
              Tell us what looks wrong. Reports are confidential and reviewed by our trust and safety team.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reportText}
            onChange={(e) => setReportText(e.target.value)}
            placeholder="Describe the problem with this campaign…"
            aria-label="Report description"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReportOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void submitReport()} disabled={report.isPending}>
              {report.isPending ? 'Sending…' : 'Submit report'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
