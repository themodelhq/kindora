import { useMemo, useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Loader2, Lock, Plus, Users, UsersRound } from 'lucide-react';
import { toast } from 'sonner';

import { useCreateCircle, useCircles, useJoinCircle } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared';
import { formatMoney, minorFromMajor, progressPercent } from '@/lib/money';
import { truncate } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import type { Circle } from '@/types/api';

function privacyVariant(privacy: Circle['privacy']): BadgeProps['variant'] {
  return privacy === 'PRIVATE' ? 'warning' : 'success';
}

function sumMinor(amounts: string[]): bigint {
  let sum = 0n;
  for (const a of amounts) {
    try {
      sum += BigInt(a);
    } catch {
      // ignore malformed amounts
    }
  }
  return sum;
}

function CircleCard({ circle }: { circle: Circle }) {
  const contributions = circle.contributions ?? [];
  const contributed = sumMinor(contributions.map((c) => c.amount));
  const members = circle.members?.length ?? 0;
  const pct = circle.goalAmount ? progressPercent(contributed.toString(), circle.goalAmount) : 0;

  return (
    <Link to={`/circles/${circle.slug}`} className="group block focus-visible:outline-none" aria-label={circle.name}>
      <Card className="h-full transition-all group-hover:-translate-y-0.5 group-hover:shadow-lift group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <CardContent className="flex h-full flex-col gap-3 p-5">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-lg font-bold leading-snug group-hover:text-primary">{circle.name}</h3>
            <Badge variant={privacyVariant(circle.privacy)}>
              {circle.privacy === 'PRIVATE' && <Lock className="h-3 w-3" aria-hidden="true" />}
              {circle.privacy === 'PRIVATE' ? 'Private' : 'Public'}
            </Badge>
          </div>
          {circle.description && (
            <p className="text-sm text-muted-foreground">{truncate(circle.description, 120)}</p>
          )}
          <div className="mt-auto space-y-3 pt-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                {members} {members === 1 ? 'member' : 'members'}
              </span>
              <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
                {formatMoney(contributed, circle.currency)}
                <span className="font-normal text-muted-foreground">contributed</span>
              </span>
            </div>
            {circle.goalAmount && <Progress value={pct} aria-label={`${pct}% of goal reached`} />}
            {circle.goalAmount && (
              <p className="text-xs text-muted-foreground">
                {pct}% of {formatMoney(circle.goalAmount, circle.currency)} goal
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function CirclesIndexPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const { data, isLoading, isError, refetch } = useCircles();
  const createCircle = useCreateCircle();
  const joinCircle = useJoinCircle();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [privacy, setPrivacy] = useState<'PUBLIC' | 'PRIVATE'>('PUBLIC');
  const [goalAmount, setGoalAmount] = useState('');
  const [campaignSlug, setCampaignSlug] = useState('');

  const [joinOpen, setJoinOpen] = useState(false);
  const [joinSlug, setJoinSlug] = useState('');
  const [inviteCode, setInviteCode] = useState('');

  const circles = useMemo(() => data?.items ?? [], [data]);

  const requireAuth = (action: string): boolean => {
    if (!user) {
      toast.error(`Sign in to ${action}`);
      navigate('/auth/login');
      return false;
    }
    return true;
  };

  const submitCreate = () => {
    if (!requireAuth('create a circle')) return;
    if (!name.trim()) {
      toast.error('Give your circle a name');
      return;
    }
    const goalMajor = Number(goalAmount);
    createCircle.mutate(
      {
        name: name.trim(),
        description: description.trim() || undefined,
        privacy,
        goalAmountMajor: goalAmount && Number.isFinite(goalMajor) && goalMajor > 0 ? goalMajor : undefined,
        campaignSlug: campaignSlug.trim() || undefined,
      },
      {
        onSuccess: (res) => {
          toast.success('Circle created');
          setCreateOpen(false);
          setName('');
          setDescription('');
          setPrivacy('PUBLIC');
          setGoalAmount('');
          setCampaignSlug('');
          navigate(`/circles/${res.circle.slug}`);
        },
        onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not create the circle'),
      },
    );
  };

  const submitJoin = () => {
    if (!requireAuth('join a circle')) return;
    if (!joinSlug.trim()) {
      toast.error('Enter the circle link or slug');
      return;
    }
    joinCircle.mutate(
      { slug: joinSlug.trim(), inviteCode: inviteCode.trim() || undefined },
      {
        onSuccess: () => {
          toast.success('Joined the circle');
          setJoinOpen(false);
          setJoinSlug('');
          setInviteCode('');
          navigate(`/circles/${joinSlug.trim()}`);
        },
        onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not join this circle'),
      },
    );
  };

  return (
    <div className="container space-y-8 py-8 md:py-12">
      {/* Hero band */}
      <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-600 via-emerald-500 to-teal-600 p-6 text-white shadow-soft md:p-10">
        <div className="max-w-2xl space-y-4">
          <p className="text-sm font-semibold uppercase tracking-widest text-white/80">Giving circles</p>
          <h1 className="text-3xl font-extrabold tracking-tight md:text-5xl">Give together.</h1>
          <p className="text-white/90 md:text-lg">
            Pool giving with friends, family or coworkers. Set a shared goal, rally around verified campaigns
            and watch your collective impact grow.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <Button
              variant="accent"
              className="min-h-11"
              onClick={() => (user ? setCreateOpen(true) : requireAuth('create a circle'))}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Create a circle
            </Button>
            <Button
              variant="outline"
              className="min-h-11 border-white/40 bg-white/10 text-white hover:bg-white/20 hover:text-white"
              onClick={() => (user ? setJoinOpen(true) : requireAuth('join a circle'))}
            >
              <UsersRound className="h-4 w-4" aria-hidden="true" />
              Join a private circle
            </Button>
          </div>
        </div>
      </section>

      {/* Circle grid */}
      <section aria-label="Giving circles" className="space-y-4">
        <h2 className="text-lg font-semibold">Browse circles</h2>
        {isLoading ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-56 rounded-2xl" />
            ))}
          </div>
        ) : isError ? (
          <EmptyState
            icon={UsersRound}
            title="Could not load circles"
            description="Something went wrong while fetching giving circles."
            action={<Button onClick={() => void refetch()}>Try again</Button>}
          />
        ) : circles.length === 0 ? (
          <EmptyState
            icon={UsersRound}
            title="No circles yet"
            description="Be the first to start a giving circle and rally your people around a cause."
            action={
              <Button onClick={() => (user ? setCreateOpen(true) : requireAuth('create a circle'))}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Create a circle
              </Button>
            }
          />
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {circles.map((circle) => (
              <CircleCard key={circle.id} circle={circle} />
            ))}
          </div>
        )}
      </section>

      {/* Create circle dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Create a giving circle</DialogTitle>
            <DialogDescription>
              Gather people around a shared goal. You can link a campaign the pool will fund.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submitCreate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="circle-name">Name</Label>
              <Input
                id="circle-name"
                value={name}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                placeholder="e.g. Lagos Giving Circle"
                className="min-h-11"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="circle-description">Description</Label>
              <Textarea
                id="circle-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this circle care about?"
                className="min-h-[80px]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="circle-privacy">Privacy</Label>
              <Select value={privacy} onValueChange={(v) => setPrivacy(v as 'PUBLIC' | 'PRIVATE')}>
                <SelectTrigger id="circle-privacy" className="min-h-11" aria-label="Circle privacy">
                  <SelectValue placeholder="Choose privacy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PUBLIC">Public — anyone can join</SelectItem>
                  <SelectItem value="PRIVATE">Private — invite code required</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="circle-goal">Goal amount (optional)</Label>
              <Input
                id="circle-goal"
                type="number"
                inputMode="decimal"
                min="0"
                step="100"
                value={goalAmount}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setGoalAmount(e.target.value)}
                placeholder="e.g. 500000"
                className="min-h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="circle-campaign">Campaign slug (optional)</Label>
              <Input
                id="circle-campaign"
                value={campaignSlug}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setCampaignSlug(e.target.value)}
                placeholder="e.g. clean-water-for-obosi"
                className="min-h-11"
              />
              <p className="text-xs text-muted-foreground">Link the campaign this pool will rally around.</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} className="min-h-11">
                Cancel
              </Button>
              <Button type="submit" disabled={createCircle.isPending} className="min-h-11">
                {createCircle.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                Create circle
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Join private circle dialog */}
      <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Join a private circle</DialogTitle>
            <DialogDescription>
              Enter the circle slug and the invite code a member shared with you.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submitJoin();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="join-slug">Circle slug</Label>
              <Input
                id="join-slug"
                value={joinSlug}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setJoinSlug(e.target.value)}
                placeholder="e.g. lagos-giving-circle"
                className="min-h-11"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="join-invite">Invite code</Label>
              <Input
                id="join-invite"
                value={inviteCode}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setInviteCode(e.target.value)}
                placeholder="e.g. KDC-8H2K4M"
                className="min-h-11 font-mono uppercase tracking-widest"
                aria-label="Invite code"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setJoinOpen(false)} className="min-h-11">
                Cancel
              </Button>
              <Button type="submit" disabled={joinCircle.isPending} className="min-h-11">
                {joinCircle.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                Join circle
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* How it works */}
      <section className="grid gap-4 md:grid-cols-3">
        {[
          { title: 'Start a pool', body: 'Name your circle, set a goal and invite people who care about the same causes.' },
          { title: 'Rally together', body: 'Members donate or pledge toward the shared goal and pick an active campaign to fund.' },
          { title: 'Transparent impact', body: 'Every contribution is visible to members and posted to the public ledger.' },
        ].map((step) => (
          <Card key={step.title}>
            <CardContent className="space-y-2 p-5">
              <h3 className="font-semibold">{step.title}</h3>
              <p className="text-sm text-muted-foreground">{step.body}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <p className="text-center text-sm text-muted-foreground">
        Curious how pooled giving moves money?{' '}
        <Link to="/impact" className="font-semibold text-primary hover:underline">
          See the public ledger
        </Link>
        <ArrowRight className="ml-1 inline h-3.5 w-3.5" aria-hidden="true" />
      </p>
    </div>
  );
}
