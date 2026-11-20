import { useMemo, useState, type ChangeEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Coins, HandHeart, Loader2, Lock, LogIn, Target, UserPlus, Users,
} from 'lucide-react';
import { toast } from 'sonner';

import { useCircle, useCampaigns, useCircleContribute, useJoinCircle } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared';
import { formatMoney, minorFromMajor, progressPercent } from '@/lib/money';
import { initials } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import type { Circle, User } from '@/types/api';

const AMOUNT_PRESETS = [1000, 5000, 10000, 50000];

interface ContributionEntry {
  id: string;
  amount: string;
  kind: string;
  note?: string | null;
  createdAt?: string;
  user: User;
}

interface LeaderboardRow {
  userId: string;
  name: string;
  totalMinor: bigint;
  hasPledge: boolean;
}

function roleVariant(role: string): BadgeProps['variant'] {
  if (role === 'OWNER') return 'default';
  if (role === 'ADMIN') return 'secondary';
  return 'muted';
}

function kindVariant(kind: string): BadgeProps['variant'] {
  return kind === 'PLEDGE' ? 'warning' : 'success';
}

export default function CircleDetailPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const { data: circle, isLoading, isError, refetch } = useCircle(slug);
  const join = useJoinCircle();
  const contribute = useCircleContribute();
  const campaignsQuery = useCampaigns({ status: 'ACTIVE', limit: 3 });
  const activeCampaigns = useMemo(() => campaignsQuery.data?.items ?? [], [campaignsQuery.data]);

  const [joinOpen, setJoinOpen] = useState(false);
  const [inviteInput, setInviteInput] = useState('');

  const [contributeOpen, setContributeOpen] = useState(false);
  const [campaignSlug, setCampaignSlug] = useState('');
  const [amount, setAmount] = useState('');
  const [kind, setKind] = useState<'DONATION' | 'PLEDGE'>('DONATION');
  const [note, setNote] = useState('');

  const members = circle?.members ?? [];
  const contributions = useMemo(() => circle?.contributions ?? [], [circle]);
  const isMember = Boolean(user && members.some((m) => m.user.id === user.id));

  // Goal progress counts DONATION contributions only.
  const donatedMinor = useMemo(() => {
    let sum = 0n;
    for (const c of contributions) {
      if (c.kind !== 'DONATION') continue;
      try {
        sum += BigInt(c.amount);
      } catch {
        // ignore malformed amounts
      }
    }
    return sum;
  }, [contributions]);

  const pct = circle?.goalAmount ? progressPercent(donatedMinor.toString(), circle.goalAmount) : 0;

  const leaderboard = useMemo<LeaderboardRow[]>(() => {
    const byUser = new Map<string, LeaderboardRow>();
    for (const c of contributions as ContributionEntry[]) {
      const key = c.user?.id ?? c.user?.email ?? 'unknown';
      const existing = byUser.get(key);
      let total = existing?.totalMinor ?? 0n;
      try {
        total += BigInt(c.amount);
      } catch {
        // ignore malformed amounts
      }
      byUser.set(key, {
        userId: key,
        name: c.user ? `${c.user.firstName} ${c.user.lastName}`.trim() || 'Member' : 'Member',
        totalMinor: total,
        hasPledge: (existing?.hasPledge ?? false) || c.kind === 'PLEDGE',
      });
    }
    return [...byUser.values()].sort((a, b) => (a.totalMinor > b.totalMinor ? -1 : a.totalMinor < b.totalMinor ? 1 : 0)).slice(0, 10);
  }, [contributions]);

  const doJoin = (code?: string) => {
    join.mutate(
      { slug, inviteCode: code },
      {
        onSuccess: () => {
          toast.success('Welcome to the circle');
          setJoinOpen(false);
          setInviteInput('');
          void refetch();
        },
        onError: (error) =>
          toast.error(
            circle?.privacy === 'PRIVATE'
              ? 'Invalid invite code'
              : error instanceof Error
                ? error.message
                : 'Could not join this circle',
          ),
      },
    );
  };

  const openContribute = (targetSlug: string) => {
    if (!user) {
      toast.error('Sign in to contribute');
      navigate('/auth/login');
      return;
    }
    if (!isMember) {
      toast.error('Join this circle before contributing');
      setJoinOpen(true);
      return;
    }
    setCampaignSlug(targetSlug);
    setAmount('');
    setNote('');
    setKind('DONATION');
    setContributeOpen(true);
  };

  const submitContribution = () => {
    if (!circle) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Enter an amount greater than zero');
      return;
    }
    contribute.mutate(
      {
        slug,
        circleId: circle.id,
        campaignSlug,
        amountMinor: minorFromMajor(value, circle.currency),
        kind,
        note: note.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success(kind === 'PLEDGE' ? 'Pledge recorded' : 'Contribution recorded');
          setContributeOpen(false);
          setAmount('');
          setNote('');
          void refetch();
        },
        onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not record the contribution'),
      },
    );
  };

  if (isLoading) {
    return (
      <div className="container space-y-6 py-8 md:py-12" aria-busy="true">
        <Skeleton className="h-44 rounded-2xl" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-72 rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (isError || !circle) {
    return (
      <div className="container py-16">
        <EmptyState
          icon={Users}
          title="Circle not found"
          description="This giving circle may be private or the link is incorrect."
          action={
            <Button onClick={() => navigate('/circles')}>Back to circles</Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="container space-y-8 py-8 md:py-12">
      {/* Header */}
      <Card className="rounded-2xl shadow-soft">
        <CardContent className="space-y-4 p-6 md:p-8">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-extrabold tracking-tight md:text-4xl">{circle.name}</h1>
            <Badge variant={circle.privacy === 'PRIVATE' ? 'warning' : 'success'}>
              {circle.privacy === 'PRIVATE' && <Lock className="h-3 w-3" aria-hidden="true" />}
              {circle.privacy === 'PRIVATE' ? 'Private' : 'Public'}
            </Badge>
          </div>
          {circle.description && <p className="max-w-2xl text-muted-foreground">{circle.description}</p>}
          <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
            {/* Member avatars */}
            <div className="flex items-center gap-3">
              <div className="flex -space-x-3" aria-label={`${members.length} members`}>
                {members.slice(0, 5).map((m) => (
                  <Avatar key={`${m.user.id}-${m.role}`} className="h-10 w-10 border-2 border-card">
                    <AvatarFallback>{initials(m.user.firstName, m.user.lastName)}</AvatarFallback>
                  </Avatar>
                ))}
                {members.length > 5 && (
                  <span className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-card bg-muted text-xs font-semibold text-muted-foreground">
                    +{members.length - 5}
                  </span>
                )}
                {members.length === 0 && (
                  <span className="text-sm text-muted-foreground">No members yet</span>
                )}
              </div>
              <span className="text-sm text-muted-foreground">
                {members.length} {members.length === 1 ? 'member' : 'members'}
              </span>
            </div>
            {/* Join action */}
            {!user ? (
              <Button asChild className="min-h-11">
                <Link to="/auth/login">
                  <LogIn className="h-4 w-4" aria-hidden="true" />
                  Sign in to join
                </Link>
              </Button>
            ) : !isMember ? (
              circle.privacy === 'PRIVATE' ? (
                <Button onClick={() => setJoinOpen(true)} className="min-h-11">
                  <UserPlus className="h-4 w-4" aria-hidden="true" />
                  Join with invite code
                </Button>
              ) : (
                <Button onClick={() => doJoin()} disabled={join.isPending} className="min-h-11">
                  {join.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  <UserPlus className="h-4 w-4" aria-hidden="true" />
                  Join circle
                </Button>
              )
            ) : (
              <Badge variant="success" className="px-3 py-1">You are a member</Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Goal progress */}
      <Card className="rounded-2xl shadow-soft">
        <CardContent className="space-y-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                <Target className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <p className="font-semibold">
                  {formatMoney(donatedMinor, circle.currency)}{' '}
                  {circle.goalAmount && <span className="font-normal text-muted-foreground">of {formatMoney(circle.goalAmount, circle.currency)}</span>}
                </p>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Donations toward the goal</p>
              </div>
            </div>
            {circle.goalAmount && (
              <span className="text-lg font-bold text-primary">{pct}%</span>
            )}
          </div>
          {circle.goalAmount ? (
            <Progress value={pct} aria-label={`${pct}% of goal reached`} />
          ) : (
            <p className="text-sm text-muted-foreground">This circle has no goal yet — every donation counts.</p>
          )}
        </CardContent>
      </Card>

      {/* Leaderboard */}
      <Card className="rounded-2xl shadow-soft">
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
              <Coins className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-lg font-semibold">Leaderboard</h2>
              <p className="text-sm text-muted-foreground">Members ranked by what they have contributed.</p>
            </div>
          </div>
          <div className="mt-4">
            {leaderboard.length === 0 ? (
              <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                No contributions yet. The leaderboard fills in as members give.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead>Total contributed</TableHead>
                    <TableHead>Kinds</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leaderboard.map((row, index) => (
                    <TableRow key={row.userId}>
                      <TableCell>
                        <span className="font-medium">
                          {index + 1}. {row.name}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-semibold tabular-nums">
                        {formatMoney(row.totalMinor, circle.currency)}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1.5">
                          <Badge variant="success">DONATION</Badge>
                          {row.hasPledge && <Badge variant={kindVariant('PLEDGE')}>PLEDGE</Badge>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Rally around a campaign */}
      <Card className="rounded-2xl shadow-soft">
        <CardContent className="space-y-4 p-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
              <HandHeart className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-lg font-semibold">Rally around a campaign</h2>
              <p className="text-sm text-muted-foreground">
                Pick an active campaign and add a donation or pledge on behalf of the circle.
              </p>
            </div>
          </div>
          {campaignsQuery.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-3" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
          ) : activeCampaigns.length === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              No active campaigns to fund right now. Check back soon.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-3">
              {activeCampaigns.map((campaign) => (
                <li key={campaign.id} className="flex flex-col justify-between gap-3 rounded-xl border p-4">
                  <div>
                    <h3 className="line-clamp-2 font-semibold leading-snug">{campaign.title}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatMoney(campaign.raisedAmount, campaign.currency)} raised
                    </p>
                  </div>
                  <Button size="sm" className="min-h-11 w-full" onClick={() => openContribute(campaign.slug)}>
                    Fund this campaign
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Members list */}
      <Card className="rounded-2xl shadow-soft">
        <CardContent className="p-6">
          <h2 className="text-lg font-semibold">Members</h2>
          <p className="text-sm text-muted-foreground">People pooling their giving in this circle.</p>
          <ul className="mt-4 space-y-3">
            {members.length === 0 && (
              <li className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                No members yet.
              </li>
            )}
            {members.map((m) => (
              <li key={`${m.user.id}-${m.role}`} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar className="h-10 w-10 border">
                    <AvatarFallback>{initials(m.user.firstName, m.user.lastName)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {m.user.firstName} {m.user.lastName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{m.user.email}</p>
                  </div>
                </div>
                <Badge variant={roleVariant(m.role)}>{m.role}</Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Join dialog (private circles) */}
      <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Join {circle.name}</DialogTitle>
            <DialogDescription>This circle is private. Enter the invite code a member shared with you.</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!inviteInput.trim()) {
                toast.error('Enter the invite code first');
                return;
              }
              doJoin(inviteInput.trim());
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="invite-code">Invite code</Label>
              <Input
                id="invite-code"
                value={inviteInput}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setInviteInput(e.target.value)}
                placeholder="e.g. KDC-8H2K4M"
                className="min-h-11 font-mono uppercase tracking-widest"
                aria-label="Invite code"
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setJoinOpen(false)} className="min-h-11">
                Cancel
              </Button>
              <Button type="submit" disabled={join.isPending} className="min-h-11">
                {join.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                Join circle
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Contribute dialog */}
      <Dialog open={contributeOpen} onOpenChange={setContributeOpen}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Contribute as {circle.name}</DialogTitle>
            <DialogDescription>
              Add a donation or pledge to the pool for the selected campaign.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submitContribution();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="contribution-campaign">Campaign</Label>
              <Select value={campaignSlug} onValueChange={setCampaignSlug}>
                <SelectTrigger id="contribution-campaign" className="min-h-11" aria-label="Campaign">
                  <SelectValue placeholder="Choose a campaign" />
                </SelectTrigger>
                <SelectContent>
                  {activeCampaigns.map((c) => (
                    <SelectItem key={c.id} value={c.slug}>
                      {c.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Amount ({circle.currency})</Label>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Amount presets">
                {AMOUNT_PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    type="button"
                    variant={Number(amount) === preset ? 'default' : 'outline'}
                    size="sm"
                    className="min-h-11"
                    onClick={() => setAmount(String(preset))}
                    aria-pressed={Number(amount) === preset}
                  >
                    {formatMoney(minorFromMajor(preset, circle.currency), circle.currency)}
                  </Button>
                ))}
              </div>
              <Input
                id="contribution-amount"
                type="number"
                inputMode="decimal"
                min="0"
                value={amount}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setAmount(e.target.value)}
                placeholder="Custom amount"
                className="min-h-11"
                aria-label="Custom amount"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contribution-kind">Type</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as 'DONATION' | 'PLEDGE')}>
                <SelectTrigger id="contribution-kind" className="min-h-11" aria-label="Contribution type">
                  <SelectValue placeholder="Choose type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DONATION">Donation</SelectItem>
                  <SelectItem value="PLEDGE">Pledge</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="contribution-note">Note (optional)</Label>
              <Textarea
                id="contribution-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="A short message for the circle"
                className="min-h-[80px]"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setContributeOpen(false)} className="min-h-11">
                Cancel
              </Button>
              <Button type="submit" disabled={contribute.isPending} className="min-h-11">
                {contribute.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {kind === 'PLEDGE' ? 'Record pledge' : 'Add contribution'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
