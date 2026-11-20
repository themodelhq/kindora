import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertCircle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Eye,
  HandCoins,
  ImageUp,
  Loader2,
  Megaphone,
  Send,
  Users,
  Wallet,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, StatCard } from '@/components/shared';
import {
  useAvailableBalance,
  useCampaignDonors,
  useCampaignUpdates,
  useCancelWithdrawal,
  useCreateCampaignUpdate,
  useMyFiles,
  useMyWithdrawals,
  useRegisterUpload,
  useSubmitCampaign,
  useUpdateCampaign,
} from '@/api/hooks';
import { api, ApiError } from '@/lib/http';
import { uploadWithPresignedPost, storedFileStatusView, UPLOAD_ACCEPT } from '@/lib/storage';
import { formatMoney, majorValue, minorFromMajor, progressPercent } from '@/lib/money';
import { formatDate, relativeTime, truncate } from '@/lib/utils';
import { campaignStatusBadge, withdrawalStatusBadge } from '@/lib/status';
import type { CampaignDetail } from '@/types/api';

interface AnalyticsDay {
  date?: string;
  donationCount?: number;
  donations?: number;
  donationAmountMinor?: string;
  amount?: string;
}

interface CampaignAnalyticsResponse {
  views?: number;
  donationsCount?: number;
  donations?: number;
  donorCount?: number;
  items?: AnalyticsDay[];
}

function shortDay(date?: string): string {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

function statusTone(status: string): 'success' | 'muted' | 'warning' {
  if (status === 'ACTIVE') return 'success';
  if (status === 'EXPIRED' || status === 'CANCELLED') return 'muted';
  return 'warning';
}

export default function OrganizerManageCampaignPage() {
  const { id } = useParams<{ id: string }>();
  const campaignId = id ?? '';
  const queryClient = useQueryClient();

  const campaignQuery = useQuery({
    queryKey: ['campaign', 'by-id', campaignId],
    queryFn: () => api<{ campaign: CampaignDetail }>('GET', `/campaigns/by-id/${campaignId}`),
    enabled: Boolean(campaignId),
    select: (res) => res?.campaign,
  });
  const campaign = campaignQuery.data;
  const slug = campaign?.slug ?? '';

  const submitForReviewMutation = useSubmitCampaign();
  const updateCampaignMutation = useUpdateCampaign(campaignId);
  const createUpdateMutation = useCreateCampaignUpdate(slug);
  const updatesQuery = useCampaignUpdates(slug);
  const balanceQuery = useAvailableBalance(campaignId);
  const withdrawalsQuery = useMyWithdrawals();
  const cancelWithdrawal = useCancelWithdrawal();
  const registerUpload = useRegisterUpload();
  const filesQuery = useMyFiles(1);

  /** GET /withdrawals/available/:campaignId is manager-only — render "Not permitted". */
  const balanceDenied =
    balanceQuery.isError && balanceQuery.error instanceof ApiError && balanceQuery.error.status === 403;

  const [donorPage, setDonorPage] = useState(1);
  const donorsQuery = useCampaignDonors(slug, donorPage);

  const analyticsQuery = useQuery({
    queryKey: ['campaign-analytics', campaignId],
    queryFn: () => api<CampaignAnalyticsResponse>('GET', `/campaigns/${campaignId}/analytics`),
    enabled: Boolean(campaignId),
  });

  // Editable story (synced from the server copy, kept editable locally).
  const [storyDraft, setStoryDraft] = useState('');
  const campaignKey = campaign?.id ?? '';
  useEffect(() => {
    if (campaign) setStoryDraft(campaign.story);
  }, [campaignKey, campaign]);

  const [updateTitle, setUpdateTitle] = useState('');
  const [updateBody, setUpdateBody] = useState('');

  const [poolName, setPoolName] = useState('');
  const [poolTotalMajor, setPoolTotalMajor] = useState('');
  const [poolRatio, setPoolRatio] = useState('100');
  const [poolCapMajor, setPoolCapMajor] = useState('');
  const [poolEndsAt, setPoolEndsAt] = useState('');
  const [savingPool, setSavingPool] = useState(false);

  // Media uploads go through the presigned POST flow (register → POST → confirm).
  const [uploading, setUploading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  // Two-step cancellation for not-yet-approved payouts.
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  const campaignWithdrawals = useMemo(
    () => (withdrawalsQuery.data?.items ?? []).filter((w) => w.campaign?.slug === slug),
    [withdrawalsQuery.data, slug],
  );

  const analytics = analyticsQuery.data;
  const analyticsDays = useMemo(() => (analytics?.items ?? []).slice(-14), [analytics]);
  const analyticsMax = useMemo(
    () => Math.max(1, ...analyticsDays.map((d) => d.donationCount ?? d.donations ?? 0)),
    [analyticsDays],
  );

  if (!campaignId) {
    return (
      <EmptyState
        icon={Megaphone}
        title="Campaign not found"
        description="We could not tell which campaign to open. Go back to the organizer dashboard and pick one."
        action={
          <Button asChild>
            <Link to="/organizer">Back to organizer</Link>
          </Button>
        }
      />
    );
  }

  if (campaignQuery.isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-52" />
        </div>
        <Skeleton className="h-11 w-full max-w-xl rounded-xl" />
        <Card>
          <CardContent className="space-y-4 p-6">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-2.5 w-full rounded-full" />
            <div className="grid gap-4 sm:grid-cols-3">
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (campaignQuery.isError || !campaign) {
    return (
      <EmptyState
        icon={Megaphone}
        title="Campaign could not be loaded"
        description={
          campaignQuery.error instanceof ApiError && campaignQuery.error.message
            ? campaignQuery.error.message
            : 'Something went wrong while fetching this campaign. It may have been removed, or you may not have access.'
        }
        action={
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => void campaignQuery.refetch()}>
              Try again
            </Button>
            <Button asChild>
              <Link to="/organizer">Back to organizer</Link>
            </Button>
          </div>
        }
      />
    );
  }

  const badge = campaignStatusBadge(campaign.status);
  const pct = progressPercent(campaign.raisedAmount, campaign.targetAmount);
  const currency = campaign.currency;
  const canSubmitForReview = campaign.status === 'DRAFT' || campaign.status === 'REJECTED';
  const showApprovalNote =
    (campaign.status === 'PENDING_REVIEW' || campaign.status === 'REJECTED') && Boolean(campaign.approvalNote);

  function invalidateCampaign() {
    void queryClient.invalidateQueries({ queryKey: ['campaign', 'by-id', campaignId] });
  }

  async function handleSubmitForReview() {
    try {
      await submitForReviewMutation.mutateAsync(campaignId);
      invalidateCampaign();
      toast.success('Submitted for review');
    } catch (error) {
      toast.error(
        error instanceof ApiError && error.message ? error.message : 'Could not submit for review. Please try again.',
      );
    }
  }

  async function handleSaveStory() {
    if (storyDraft.trim().length < 120) {
      toast.error('The story needs at least 120 characters before saving.');
      return;
    }
    try {
      await updateCampaignMutation.mutateAsync({ story: storyDraft.trim() });
      invalidateCampaign();
      toast.success('Story saved');
    } catch (error) {
      toast.error(error instanceof ApiError && error.message ? error.message : 'Could not save the story. Please try again.');
    }
  }

  async function handlePostUpdate() {
    if (!updateTitle.trim() || !updateBody.trim()) {
      toast.error('Add a title and a message for your update.');
      return;
    }
    try {
      await createUpdateMutation.mutateAsync({ title: updateTitle.trim(), body: updateBody.trim() });
      setUpdateTitle('');
      setUpdateBody('');
      toast.success('Update posted');
    } catch (error) {
      toast.error(error instanceof ApiError && error.message ? error.message : 'Could not post the update. Please try again.');
    }
  }

  /** Cover image upload: presigned POST policy + direct upload + confirm. */
  async function handleCoverUpload(file: File) {
    setMediaError(null);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setMediaError('Cover images must be JPEG, PNG or WebP.');
      return;
    }
    setUploading(true);
    try {
      const registration = await registerUpload.mutateAsync({
        fileName: file.name,
        contentType: file.type,
        kind: 'campaign-image',
        campaignId,
      });
      await uploadWithPresignedPost(registration, file);
      toast.success('Upload complete — the file is being scanned.');
      void queryClient.invalidateQueries({ queryKey: ['storage'] });
    } catch (error) {
      setMediaError(
        error instanceof ApiError && error.message
          ? error.message
          : 'Could not upload the image. Please try again.',
      );
    } finally {
      setUploading(false);
    }
  }

  function handleCancelWithdrawal(withdrawal: (typeof campaignWithdrawals)[number]) {
    cancelWithdrawal.mutate(withdrawal.id, {
      onSuccess: () => {
        toast.success(`Withdrawal ${withdrawal.publicRef} cancelled`);
        setConfirmCancelId(null);
      },
      onError: (error) =>
        toast.error(
          error instanceof ApiError && error.message
            ? error.message
            : 'Could not cancel the withdrawal. Please try again.',
        ),
    });
  }

  async function handleCreatePool() {
    if (!poolName.trim()) {
      toast.error('Give the matching pool a name.');
      return;
    }
    const totalCommitted = minorFromMajor(Number(poolTotalMajor) || 0, currency);
    if (totalCommitted <= 0) {
      toast.error('Enter the total amount the sponsor commits.');
      return;
    }
    const ratio = Number(poolRatio);
    if (!poolRatio || Number.isNaN(ratio) || ratio <= 0) {
      toast.error('Enter a match ratio greater than zero (100 means 1:1).');
      return;
    }
    setSavingPool(true);
    try {
      await api('POST', `/campaigns/${campaignId}/matching-pools`, {
        name: poolName.trim(),
        totalCommittedMinor: totalCommitted,
        matchRatio: ratio,
        capPerDonationMinor: minorFromMajor(Number(poolCapMajor) || 0, currency),
        ...(poolEndsAt ? { endsAt: new Date(`${poolEndsAt}T23:59:59`).toISOString() } : {}),
      });
      setPoolName('');
      setPoolTotalMajor('');
      setPoolRatio('100');
      setPoolCapMajor('');
      setPoolEndsAt('');
      invalidateCampaign();
      toast.success('Matching pool created');
    } catch (error) {
      toast.error(
        error instanceof ApiError && error.message ? error.message : 'Could not create the matching pool. Please try again.',
      );
    } finally {
      setSavingPool(false);
    }
  }

  const donorItems = donorsQuery.data?.items ?? [];
  const donorTotal = donorsQuery.data?.total ?? 0;
  const donorPageSize = donorItems.length > 0 ? donorItems.length : 10;
  const donorPageCount = Math.max(1, Math.ceil(donorTotal / donorPageSize));

  const analyticsViews = campaign.viewCount ?? analytics?.views ?? 0;
  const analyticsDonations = analytics?.donationsCount ?? analytics?.donations ?? 0;
  const analyticsDonors = analytics?.donorCount ?? campaign.donorCount;
  const balance = balanceQuery.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-extrabold tracking-tight md:text-3xl">{campaign.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant={badge.variant}>{badge.label}</Badge>
            <span>Created {formatDate(campaign.createdAt)}</span>
            {campaign.category && <span>· {campaign.category.name}</span>}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to={`/campaigns/${campaign.slug}`}>View public page</Link>
        </Button>
      </div>

      <Tabs defaultValue="overview">
        <TabsList aria-label="Campaign sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="updates">Updates</TabsTrigger>
          <TabsTrigger value="donors">Donors</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
          <TabsTrigger value="withdrawal">Withdrawal</TabsTrigger>
          <TabsTrigger value="media">Media</TabsTrigger>
          <TabsTrigger value="matching">Matching</TabsTrigger>
        </TabsList>

        {/* ---------------- Overview ---------------- */}
        <TabsContent value="overview" className="space-y-4">
          {showApprovalNote && (
            <Card className={campaign.status === 'REJECTED' ? 'border-destructive/40' : 'border-amber-200'}>
              <CardContent className="p-5">
                <p className="font-semibold">
                  {campaign.status === 'REJECTED' ? 'Review feedback' : 'In review'}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{campaign.approvalNote}</p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div className="space-y-1.5">
                <CardTitle>Fundraising progress</CardTitle>
                <CardDescription>
                  {formatMoney(campaign.raisedAmount, currency)} raised of{' '}
                  {formatMoney(campaign.targetAmount, currency)}
                </CardDescription>
              </div>
              <span className="text-2xl font-extrabold text-primary">{pct}%</span>
            </CardHeader>
            <CardContent className="space-y-4">
              <Progress value={pct} aria-label={`${pct}% funded`} />
              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard label="Donors" value={campaign.donorCount.toLocaleString()} hint="Unique supporters" />
                <StatCard label="Views" value={campaign.viewCount.toLocaleString()} hint="Public page visits" tone="accent" />
                <StatCard label="Status" value={badge.label} hint={`Campaign is ${badge.label.toLowerCase()}`} tone="plain" />
              </div>
              {canSubmitForReview && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted p-4">
                  <p className="text-sm text-muted-foreground">
                    {campaign.status === 'REJECTED'
                      ? 'Address the review feedback, then resubmit for approval.'
                      : 'This campaign is still a draft. Submit it to the KINDORA team for review.'}
                  </p>
                  <Button onClick={() => void handleSubmitForReview()} disabled={submitForReviewMutation.isPending}>
                    {submitForReviewMutation.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
                    {submitForReviewMutation.isPending ? 'Submitting…' : 'Submit for review'}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Edit story</CardTitle>
              <CardDescription>
                Update the narrative donors see on the public page. Changes save immediately.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={storyDraft}
                onChange={(e) => setStoryDraft(e.target.value)}
                className="min-h-[220px]"
                aria-label="Campaign story"
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">{storyDraft.trim().length} characters</p>
                <Button onClick={() => void handleSaveStory()} disabled={updateCampaignMutation.isPending}>
                  {updateCampaignMutation.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
                  {updateCampaignMutation.isPending ? 'Saving…' : 'Save story'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------- Updates ---------------- */}
        <TabsContent value="updates" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Post an update</CardTitle>
              <CardDescription>Keep donors in the loop — updates appear on the public campaign page.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="update-title">Title</Label>
                <Input
                  id="update-title"
                  value={updateTitle}
                  onChange={(e) => setUpdateTitle(e.target.value)}
                  placeholder="Drilling started on borehole #2"
                  maxLength={120}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="update-body">Message</Label>
                <Textarea
                  id="update-body"
                  value={updateBody}
                  onChange={(e) => setUpdateBody(e.target.value)}
                  placeholder="Share progress, photos of the work, and what is next."
                  className="min-h-[140px]"
                />
              </div>
              <Button onClick={() => void handlePostUpdate()} disabled={createUpdateMutation.isPending}>
                {createUpdateMutation.isPending ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Send aria-hidden="true" />
                )}
                {createUpdateMutation.isPending ? 'Posting…' : 'Post update'}
              </Button>
            </CardContent>
          </Card>

          {updatesQuery.isLoading ? (
            <Card>
              <CardContent className="space-y-4 p-6">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="space-y-2">
                    <Skeleton className="h-5 w-64" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : (updatesQuery.data?.items ?? []).length === 0 ? (
            <EmptyState
              icon={Megaphone}
              title="No updates yet"
              description="Post your first update to show donors the difference their gifts are making."
            />
          ) : (
            <div className="space-y-4">
              {(updatesQuery.data?.items ?? []).map((update) => (
                <Card key={update.id}>
                  <CardContent className="space-y-2 p-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="font-semibold">{update.title}</h3>
                      <p className="text-xs text-muted-foreground">
                        {relativeTime(update.createdAt)} · {update.author.firstName} {update.author.lastName}
                      </p>
                    </div>
                    <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{update.body}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ---------------- Donors ---------------- */}
        <TabsContent value="donors" className="space-y-4">
          {donorsQuery.isLoading ? (
            <Card>
              <CardContent className="space-y-4 p-6">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between gap-3">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : donorItems.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No donors yet"
              description="When people donate to this campaign, their support shows up here."
              action={
                <Button asChild variant="outline">
                  <Link to={`/campaigns/${campaign.slug}`}>Share campaign</Link>
                </Button>
              }
            />
          ) : (
            <Card>
              <CardContent className="p-2 md:p-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Donor</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Matched</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Message</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {donorItems.map((donor) => (
                      <TableRow key={donor.publicRef}>
                        <TableCell className="font-medium">{donor.isAnonymous ? 'Anonymous donor' : donor.donorName}</TableCell>
                        <TableCell className="whitespace-nowrap text-right font-semibold">
                          {formatMoney(donor.amount, donor.currency)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right text-muted-foreground">
                          {Number(donor.matchedAmount) > 0 ? formatMoney(donor.matchedAmount, donor.currency) : '—'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDate(donor.createdAt)}
                        </TableCell>
                        <TableCell className="max-w-[220px] text-muted-foreground">
                          {donor.message ? truncate(donor.message, 60) : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {donorItems.length > 0 && donorTotal > donorPageSize && (
            <nav className="flex items-center justify-between" aria-label="Donors pagination">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDonorPage((p) => Math.max(1, p - 1))}
                disabled={donorPage <= 1 || donorsQuery.isFetching}
              >
                <ChevronLeft aria-hidden="true" />
                Previous
              </Button>
              <span className="text-sm text-muted-foreground" aria-live="polite">
                Page {donorPage} of {donorPageCount} · {donorTotal} donors
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDonorPage((p) => Math.min(donorPageCount, p + 1))}
                disabled={donorPage >= donorPageCount || donorsQuery.isFetching}
              >
                Next
                <ChevronRight aria-hidden="true" />
              </Button>
            </nav>
          )}
        </TabsContent>

        {/* ---------------- Analytics ---------------- */}
        <TabsContent value="analytics" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Page views" value={analyticsViews.toLocaleString()} hint="Public campaign page" />
            <StatCard
              label="Donations"
              value={analyticsDonations.toLocaleString()}
              hint="Gifts received"
              tone="primary"
            />
            <StatCard label="Donors" value={analyticsDonors.toLocaleString()} hint="Unique supporters" tone="accent" />
          </div>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div className="space-y-1.5">
                <CardTitle>Last 14 days</CardTitle>
                <CardDescription>Donation activity per day.</CardDescription>
              </div>
              <BarChart3 className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            </CardHeader>
            <CardContent>
              {analyticsQuery.isLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 7 }).map((_, i) => (
                    <Skeleton key={i} className="h-2.5 w-full rounded-full" />
                  ))}
                </div>
              ) : analyticsDays.length === 0 ? (
                <p className="rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
                  Daily analytics are not available yet. Check back after the campaign receives its first visitors.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {analyticsDays.map((day, index) => {
                    const count = day.donationCount ?? day.donations ?? 0;
                    const amountMinor = Number(day.donationAmountMinor ?? day.amount ?? 0);
                    return (
                      <div key={day.date ?? index} className="flex items-center gap-3">
                        <span className="w-16 shrink-0 text-xs text-muted-foreground">{shortDay(day.date)}</span>
                        <div
                          className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted"
                          role="img"
                          aria-label={`${count} donations on ${shortDay(day.date)}`}
                        >
                          <div
                            className="h-full rounded-full bg-primary/70"
                            style={{ width: `${Math.round((count / analyticsMax) * 100)}%` }}
                          />
                        </div>
                        <span className="w-28 shrink-0 text-right text-xs font-medium">
                          {count} {count === 1 ? 'gift' : 'gifts'}
                          {amountMinor > 0 ? ` · ${formatMoney(amountMinor, currency)}` : ''}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------- Withdrawal ---------------- */}
        <TabsContent value="withdrawal" className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div className="space-y-1.5">
                <CardTitle>Available balance</CardTitle>
                <CardDescription>Settled funds you can request as a payout.</CardDescription>
              </div>
              <Wallet className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            </CardHeader>
            <CardContent className="space-y-4">
              {balanceQuery.isLoading ? (
                <Skeleton className="h-9 w-40" />
              ) : balanceDenied ? (
                <p className="flex items-center gap-2 text-base font-semibold text-muted-foreground">
                  <AlertCircle className="h-5 w-5" aria-hidden="true" />
                  Not permitted — balances are visible to campaign managers only.
                </p>
              ) : (
                <p className="text-3xl font-extrabold text-primary">
                  {formatMoney(balance?.availableMinor ?? '0', balance?.currency ?? currency)}
                </p>
              )}
              <Button asChild>
                <Link to={`/organizer/new-withdrawal?campaign=${campaignId}`}>
                  <HandCoins aria-hidden="true" />
                  Request withdrawal
                </Link>
              </Button>
              <p className="text-xs text-muted-foreground">
                Platform fee: 0% (tips-based model). Provider transfer fees may apply.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Withdrawal history</CardTitle>
              <CardDescription>Requests made against this campaign.</CardDescription>
            </CardHeader>
            <CardContent>
              {withdrawalsQuery.isLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <Skeleton key={i} className="h-4 w-full" />
                  ))}
                </div>
              ) : campaignWithdrawals.length === 0 ? (
                <p className="rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
                  No withdrawals for this campaign yet.
                </p>
              ) : (
                <ul className="divide-y">
                  {campaignWithdrawals.map((withdrawal) => {
                    const wBadge = withdrawalStatusBadge(withdrawal.status);
                    const cancellable =
                      withdrawal.status === 'PENDING'
                      || withdrawal.status === 'UNDER_REVIEW'
                      || withdrawal.status === 'REQUIRES_INFORMATION';
                    return (
                      <li key={withdrawal.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">
                            {formatMoney(withdrawal.amount, withdrawal.currency)}{' '}
                            <span className="text-xs font-normal text-muted-foreground">· {withdrawal.publicRef}</span>
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Requested {formatDate(withdrawal.createdAt)}
                            {withdrawal.paidAt ? ` · paid ${formatDate(withdrawal.paidAt)}` : ''}
                            {withdrawal.status === 'REQUIRES_INFORMATION' && withdrawal.adminNote
                              ? ` · needs: ${truncate(withdrawal.adminNote, 60)}`
                              : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {cancellable && confirmCancelId !== withdrawal.id && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="min-h-11"
                              disabled={cancelWithdrawal.isPending}
                              onClick={() => setConfirmCancelId(withdrawal.id)}
                              aria-label={`Cancel withdrawal ${withdrawal.publicRef}`}
                            >
                              <XCircle className="h-4 w-4" aria-hidden="true" />
                              Cancel
                            </Button>
                          )}
                          {cancellable && confirmCancelId === withdrawal.id && (
                            <>
                              <span className="text-xs font-medium text-muted-foreground">Cancel this request?</span>
                              <Button
                                size="sm"
                                variant="destructive"
                                className="min-h-11"
                                disabled={cancelWithdrawal.isPending}
                                onClick={() => handleCancelWithdrawal(withdrawal)}
                              >
                                {cancelWithdrawal.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                                Confirm cancel
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="min-h-11"
                                onClick={() => setConfirmCancelId(null)}
                              >
                                Keep
                              </Button>
                            </>
                          )}
                          <Badge variant={wBadge.variant}>{wBadge.label}</Badge>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------- Media ---------------- */}
        <TabsContent value="media" className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div className="space-y-1.5">
                <CardTitle>Cover image</CardTitle>
                <CardDescription>
                  JPEG, PNG or WebP. Uploads go straight to encrypted storage and are scanned for malware before use.
                </CardDescription>
              </div>
              <ImageUp className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="media-file">Upload an image</Label>
                <Input
                  id="media-file"
                  type="file"
                  accept={UPLOAD_ACCEPT['campaign-image']}
                  disabled={uploading}
                  className="min-h-11"
                  aria-describedby="media-hint"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleCoverUpload(file);
                    e.target.value = '';
                  }}
                />
                <p id="media-hint" className="text-xs text-muted-foreground">
                  Files are quarantined first, then scanned. Approved files are safe to use on the campaign page.
                </p>
              </div>
              {uploading && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Uploading and scanning…
                </p>
              )}
              {mediaError && (
                <p role="alert" className="flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {mediaError}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent uploads</CardTitle>
              <CardDescription>Files you uploaded, with their security-scan status.</CardDescription>
            </CardHeader>
            <CardContent>
              {filesQuery.isLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-4 w-full" />
                  ))}
                </div>
              ) : (filesQuery.data?.items ?? []).length === 0 ? (
                <p className="rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
                  No uploads yet. Cover images you add above appear here with their scan status.
                </p>
              ) : (
                <ul className="divide-y">
                  {(filesQuery.data?.items ?? []).slice(0, 8).map((file) => {
                    const view = storedFileStatusView(file);
                    return (
                      <li key={file.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{file.fileName}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(file.createdAt)} · {Math.max(1, Math.ceil(Number(file.sizeBytes) / 1024))} KB ·{' '}
                            {file.visibility.toLowerCase()}
                          </p>
                        </div>
                        <Badge variant={view.variant}>{view.label}</Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------- Matching ---------------- */}
        <TabsContent value="matching" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Matching pools</CardTitle>
              <CardDescription>
                Sponsors can commit matching funds so each donation goes further. Active pools amplify eligible gifts
                automatically.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {campaign.matchingPools.length === 0 ? (
                <p className="rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
                  No matching pools yet. Add a sponsor below to boost early momentum.
                </p>
              ) : (
                <ul className="divide-y">
                  {campaign.matchingPools.map((pool) => (
                    <li key={pool.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{pool.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatMoney(pool.totalCommitted, currency)} committed ·{' '}
                          {formatMoney(pool.matchedAmount, currency)} matched · 1:{pool.matchRatio} ratio
                        </p>
                      </div>
                      <Badge variant={statusTone(pool.status)}>{pool.status}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Add a sponsor pool</CardTitle>
              <CardDescription>
                Commit funds on behalf of a sponsor. A ratio of 100 means every donation is matched 1:1 up to the cap.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="max-w-xl space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleCreatePool();
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="pool-name">Sponsor / pool name</Label>
                  <Input
                    id="pool-name"
                    value={poolName}
                    onChange={(e) => setPoolName(e.target.value)}
                    placeholder="Acme Foundation match"
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="pool-total">Total committed ({currency})</Label>
                    <Input
                      id="pool-total"
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="any"
                      value={poolTotalMajor}
                      onChange={(e) => setPoolTotalMajor(e.target.value)}
                      placeholder="1000000"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pool-ratio">Match ratio (%)</Label>
                    <Input
                      id="pool-ratio"
                      type="number"
                      inputMode="numeric"
                      min="1"
                      step="1"
                      value={poolRatio}
                      onChange={(e) => setPoolRatio(e.target.value)}
                      placeholder="100"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pool-cap">Cap per donation ({currency})</Label>
                    <Input
                      id="pool-cap"
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="any"
                      value={poolCapMajor}
                      onChange={(e) => setPoolCapMajor(e.target.value)}
                      placeholder="20000"
                    />
                    {Number(poolCapMajor) > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Caps each matched gift at {formatMoney(minorFromMajor(Number(poolCapMajor), currency), currency)}.
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pool-ends">Ends on (optional)</Label>
                    <Input
                      id="pool-ends"
                      type="date"
                      value={poolEndsAt}
                      onChange={(e) => setPoolEndsAt(e.target.value)}
                      min={new Date().toISOString().slice(0, 10)}
                    />
                  </div>
                </div>
                {Number(poolTotalMajor) > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Committing {formatMoney(minorFromMajor(Number(poolTotalMajor), currency), currency)}
                    {Number(poolCapMajor) > 0
                      ? ` — about ${Math.max(1, Math.floor(majorValue(minorFromMajor(Number(poolTotalMajor), currency), currency) / Math.max(majorValue(minorFromMajor(Number(poolCapMajor), currency), currency), 1)))} capped gifts`
                      : ''}
                    .
                  </p>
                )}
                <Separator />
                <Button type="submit" disabled={savingPool}>
                  {savingPool && <Loader2 className="animate-spin" aria-hidden="true" />}
                  {savingPool ? 'Creating…' : 'Create matching pool'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        Public page: /campaigns/{campaign.slug}
      </div>
    </div>
  );
}
