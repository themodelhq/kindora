import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight, BadgeCheck, HandCoins, HandHeart, PackageCheck, ScrollText, Search, Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { CampaignCard, CampaignCardSkeleton } from '@/components/campaign-card';
import { CATEGORY_META } from '@/components/campaign-category';
import { EmptyState } from '@/components/shared';
import { useCampaigns, useImpactSummary } from '@/api/hooks';
import { formatMoney } from '@/lib/money';
import { CATEGORIES } from '@/lib/constants';

interface Feature {
  icon: LucideIcon;
  title: string;
  description: string;
}

const FEATURES: Feature[] = [
  {
    icon: ScrollText,
    title: 'Transparent ledgers',
    description:
      'Every donation, tip, payout and sponsor match is posted to a public double-entry ledger. You can audit the money trail for any campaign, any time.',
  },
  {
    icon: BadgeCheck,
    title: 'Verified organizers',
    description:
      'No campaign goes live until its organizer passes identity verification and our review team approves the story, budget and supporting documents.',
  },
  {
    icon: HandCoins,
    title: 'Matching pools',
    description:
      'Sponsors fund pools that double donations while funds last. Each match is recorded on the ledger, so you always see who amplified your gift.',
  },
];

const STEPS = [
  {
    icon: Search,
    title: 'Find a cause you trust',
    description: 'Browse verified campaigns by category, country or urgency, and read the story behind every fundraiser.',
  },
  {
    icon: HandHeart,
    title: 'Give in a few taps',
    description: 'Pay securely with cards, bank transfer, mobile money or PayPal. Give once or set up a monthly gift.',
  },
  {
    icon: ScrollText,
    title: 'Track every naira',
    description: 'Watch donations, tips and matches post to the public ledger in real time, entry by entry.',
  },
  {
    icon: PackageCheck,
    title: 'See the outcome',
    description: 'Organizers post updates and publish expense receipts, then withdraw funds with a visible audit trail.',
  },
];

export default function HomePage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const featured = useCampaigns({ status: 'ACTIVE', sort: 'trending', limit: 6 });
  const impact = useImpactSummary();

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(query.trim() ? `/campaigns?q=${encodeURIComponent(query.trim())}` : '/campaigns');
  };

  const featuredItems = featured.data?.items ?? [];

  return (
    <div>
      {/* Hero */}
      <section className="bg-gradient-to-b from-secondary/70 via-background to-background" aria-labelledby="hero-heading">
        <div className="container grid items-center gap-10 py-12 lg:grid-cols-2 lg:py-20">
          <div className="animate-fade-up">
            <p className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent-foreground">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              Crowdfunding with a public money trail
            </p>
            <h1 id="hero-heading" className="text-4xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl">
              Goodness, <span className="text-primary">in motion.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
              KINDORA helps people and verified organizations raise funds for medical care, education, clean water and
              emergencies — with every donation posted to a public ledger you can check yourself.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg">
                <Link to="/start">Start a campaign</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/campaigns">
                  Explore campaigns
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </div>
          <div className="relative animate-fade-up">
            <img
              src="/hero.png"
              alt="Community giving together"
              className="w-full rounded-2xl shadow-lift"
              loading="eager"
            />
          </div>
        </div>
      </section>

      {/* Search + categories */}
      <section className="container pb-12" aria-labelledby="discover-heading">
        <Card className="border-none bg-card/80 shadow-soft backdrop-blur">
          <CardContent className="space-y-5 p-6 lg:p-8">
            <div>
              <h2 id="discover-heading" className="text-xl font-bold">What do you care about?</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Search thousands of verified causes, or jump straight to a category.
              </p>
            </div>
            <form onSubmit={submitSearch} className="flex flex-col gap-3 sm:flex-row" role="search">
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search campaigns, e.g. borehole, tuition, clinic"
                aria-label="Search campaigns"
                className="h-12 flex-1 text-base"
              />
              <Button type="submit" size="lg" className="h-12 sm:w-40">
                <Search className="h-4 w-4" aria-hidden="true" />
                Search
              </Button>
            </form>
            <ul className="flex flex-wrap gap-2" aria-label="Campaign categories">
              {CATEGORIES.map((cat) => {
                const Icon = CATEGORY_META[cat.slug]?.icon;
                return (
                  <li key={cat.slug}>
                    <Link
                      to={`/campaigns?category=${cat.slug}`}
                      className="inline-flex min-h-11 items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {Icon && <Icon className="h-4 w-4 text-primary" aria-hidden="true" />}
                      {cat.name}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      </section>

      {/* Featured causes */}
      <section className="container pb-14" aria-labelledby="featured-heading">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h2 id="featured-heading" className="text-2xl font-extrabold tracking-tight sm:text-3xl">
              Featured causes
            </h2>
            <p className="mt-1 text-muted-foreground">Trending verified campaigns raising funds right now.</p>
          </div>
          <Button asChild variant="ghost" className="shrink-0 text-primary">
            <Link to="/campaigns">
              See all
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>
        {featured.isError ? (
          <EmptyState
            icon={Search}
            title="We could not load campaigns"
            description="The KINDORA service seems unreachable right now. Please try again in a moment."
            action={
              <Button onClick={() => featured.refetch()} variant="outline">
                Try again
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {featured.isLoading
              ? Array.from({ length: 6 }).map((_, i) => <CampaignCardSkeleton key={i} />)
              : featuredItems.map((c) => <CampaignCard key={c.id} campaign={c} />)}
          </div>
        )}
      </section>

      {/* Why KINDORA */}
      <section className="bg-secondary/50 py-14" aria-labelledby="why-heading">
        <div className="container">
          <h2 id="why-heading" className="text-center text-2xl font-extrabold tracking-tight sm:text-3xl">
            Why KINDORA
          </h2>
          <p className="mx-auto mt-2 max-w-2xl text-center text-muted-foreground">
            Traditional fundraisers ask you to trust. We ask you to verify.
          </p>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {FEATURES.map((f) => (
              <Card key={f.title} className="h-full">
                <CardContent className="flex flex-col items-start gap-4 p-6">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10" aria-hidden="true">
                    <f.icon className="h-6 w-6 text-primary" />
                  </span>
                  <h3 className="text-lg font-bold">{f.title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{f.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Live impact band */}
      <section className="bg-primary py-12 text-primary-foreground" aria-labelledby="impact-heading">
        <div className="container">
          <div className="flex flex-col items-start justify-between gap-6 lg:flex-row lg:items-end">
            <div>
              <h2 id="impact-heading" className="text-2xl font-extrabold tracking-tight sm:text-3xl">
                Live impact
              </h2>
              <p className="mt-1 text-primary-foreground/80">
                Straight from the public ledger — no cherry-picked numbers.
              </p>
            </div>
            <Button asChild variant="accent">
              <Link to="/impact">Open the public ledger</Link>
            </Button>
          </div>
          <dl className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {impact.isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="rounded-2xl bg-white/10 p-6">
                  <Skeleton className="h-4 w-24 bg-white/20" />
                  <Skeleton className="mt-3 h-8 w-32 bg-white/20" />
                </div>
              ))
            ) : (
              <>
                <div className="rounded-2xl bg-white/10 p-6">
                  <dt className="text-sm font-medium text-primary-foreground/80">Donations confirmed</dt>
                  <dd className="mt-2 text-3xl font-extrabold">
                    {(impact.data?.totalDonations ?? 0).toLocaleString()}
                  </dd>
                </div>
                <div className="rounded-2xl bg-white/10 p-6">
                  <dt className="text-sm font-medium text-primary-foreground/80">Ledger transactions</dt>
                  <dd className="mt-2 text-3xl font-extrabold">
                    {(impact.data?.ledger?.ledgerTransactions ?? 0).toLocaleString()}
                  </dd>
                </div>
                <div className="rounded-2xl bg-white/10 p-6">
                  <dt className="text-sm font-medium text-primary-foreground/80">Tips supporting KINDORA</dt>
                  <dd className="mt-2 text-3xl font-extrabold">
                    {formatMoney(impact.data?.totalTipsMinor ?? '0', 'NGN')}
                  </dd>
                </div>
              </>
            )}
          </dl>
        </div>
      </section>

      {/* How it works */}
      <section className="container py-14" aria-labelledby="how-heading">
        <h2 id="how-heading" className="text-center text-2xl font-extrabold tracking-tight sm:text-3xl">
          How KINDORA works
        </h2>
        <p className="mx-auto mt-2 max-w-2xl text-center text-muted-foreground">
          From finding a cause to seeing its impact — four steps, fully in the open.
        </p>
        <ol className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <li key={step.title}>
              <Card className="h-full">
                <CardContent className="space-y-4 p-6">
                  <div className="flex items-center justify-between">
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/20" aria-hidden="true">
                      <step.icon className="h-5 w-5 text-accent-foreground" />
                    </span>
                    <span className="text-3xl font-extrabold text-primary/15" aria-hidden="true">
                      {i + 1}
                    </span>
                  </div>
                  <h3 className="font-bold">{step.title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{step.description}</p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      {/* Closing CTA */}
      <section className="container pb-16" aria-labelledby="cta-heading">
        <div className="rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-700 px-6 py-12 text-center text-white shadow-lift sm:px-12">
          <h2 id="cta-heading" className="text-2xl font-extrabold tracking-tight sm:text-3xl">
            Ready to move goodness forward?
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-emerald-50">
            Start a fundraiser for someone who needs it, or back a verified cause today. Either way, every naira stays
            on the record.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" variant="accent">
              <Link to="/start">Start a campaign</Link>
            </Button>
            <Button
              asChild
              size="lg"
              className="border border-white/40 bg-white/10 text-white shadow-none hover:bg-white/20"
            >
              <Link to="/campaigns">Explore campaigns</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
