import { Link } from 'react-router-dom';
import {
  ArrowRight, BadgeCheck, Building2, FileSearch, HandHeart, HeartHandshake, PenLine, Rocket, ScrollText, Search, Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

const DONOR_STEPS = [
  {
    icon: Search,
    title: 'Find a cause',
    text: 'Browse or search verified campaigns by category, country, or urgency. Every listing shows how much has been raised, from how many donors, and when the fundraiser ends.',
  },
  {
    icon: HandHeart,
    title: 'Give securely',
    text: 'Check out in a few taps with cards, bank transfer, USSD, mobile money, or PayPal — through regulated providers such as Paystack, Flutterwave, Stripe, and PayPal. Add an optional tip if you want KINDORA to keep running.',
  },
  {
    icon: ScrollText,
    title: 'Watch the ledger',
    text: 'Your donation posts to the public double-entry ledger within moments, with a receipt reference. Sponsor matches show up as separate entries so you always see the true effect of your gift.',
  },
  {
    icon: FileSearch,
    title: 'Follow the outcome',
    text: 'Organizers post updates and publish expense receipts. When funds are withdrawn, the payout appears on the campaign record — generosity with an audit trail.',
  },
];

const ORGANIZER_STEPS = [
  {
    icon: PenLine,
    title: 'Tell the story',
    text: 'Create an account and build your campaign: a clear title, the goal amount and currency, the deadline, and an honest story with a line-by-line budget. You can draft freely and edit until you submit.',
  },
  {
    icon: BadgeCheck,
    title: 'Get verified',
    text: 'Submit your identity documents (and organization registration papers if you fundraise as a nonprofit). Our review team checks that the person and the purpose are real before anything is published.',
  },
  {
    icon: Rocket,
    title: 'Launch and update',
    text: 'Once approved, your campaign goes live and appears in search and discovery. Post updates as work progresses — donors who gave to you are notified when you do.',
  },
  {
    icon: Wallet,
    title: 'Withdraw with receipts',
    text: 'Request withdrawals to your bank account or mobile money wallet. Requests are reviewed, then paid with a transfer reference that is recorded on the campaign ledger alongside every donation you received.',
  },
];

export default function HowItWorksPage() {
  return (
    <div>
      <section className="bg-gradient-to-b from-secondary/70 to-background" aria-labelledby="hiw-heading">
        <div className="container py-12 lg:py-16">
          <h1 id="hiw-heading" className="text-3xl font-extrabold tracking-tight sm:text-4xl">How KINDORA works</h1>
          <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
            Four steps for donors, four steps for organizers, and one shared rule: every movement of money is recorded
            on a public ledger.
          </p>
        </div>
      </section>

      <div className="container space-y-14 py-10 lg:py-14">
        {/* For donors */}
        <section aria-labelledby="donors-steps-heading">
          <h2 id="donors-steps-heading" className="text-2xl font-extrabold tracking-tight">For donors</h2>
          <ol className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {DONOR_STEPS.map((s, i) => (
              <li key={s.title}>
                <Card className="h-full">
                  <CardContent className="space-y-4 p-6">
                    <div className="flex items-center justify-between">
                      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10" aria-hidden="true">
                        <s.icon className="h-5 w-5 text-primary" />
                      </span>
                      <span className="text-3xl font-extrabold text-primary/15" aria-hidden="true">{i + 1}</span>
                    </div>
                    <h3 className="font-bold">{s.title}</h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">{s.text}</p>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ol>
        </section>

        {/* For organizers */}
        <section aria-labelledby="organizer-steps-heading">
          <h2 id="organizer-steps-heading" className="text-2xl font-extrabold tracking-tight">For organizers</h2>
          <ol className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {ORGANIZER_STEPS.map((s, i) => (
              <li key={s.title}>
                <Card className="h-full">
                  <CardContent className="space-y-4 p-6">
                    <div className="flex items-center justify-between">
                      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/25" aria-hidden="true">
                        <s.icon className="h-5 w-5 text-accent-foreground" />
                      </span>
                      <span className="text-3xl font-extrabold text-accent/40" aria-hidden="true">{i + 1}</span>
                    </div>
                    <h3 className="font-bold">{s.title}</h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">{s.text}</p>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ol>
        </section>

        {/* Fees */}
        <section aria-labelledby="fees-heading">
          <Card>
            <CardContent className="p-6 lg:p-8">
              <h2 id="fees-heading" className="text-2xl font-extrabold tracking-tight">Fees, plainly stated</h2>
              <div className="mt-6 grid gap-8 lg:grid-cols-3">
                <div className="space-y-2">
                  <h3 className="flex items-center gap-2 font-bold"><HeartHandshake className="h-4 w-4 text-primary" aria-hidden="true" /> No mandatory platform fee</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    KINDORA takes zero percent of what you raise. Instead, donors are invited to leave an optional tip
                    (they choose 0%, 5%, or 10%) which funds verification, review, and keeping the ledger public.
                  </p>
                </div>
                <div className="space-y-2">
                  <h3 className="flex items-center gap-2 font-bold"><Building2 className="h-4 w-4 text-primary" aria-hidden="true" /> Provider processing fees</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Payments are processed by regulated providers — Paystack, Flutterwave, Stripe, and PayPal — each of
                    which charges its own processing fee under its published pricing. The applicable provider is shown
                    before a donor confirms payment, and payout fees are disclosed before an organizer withdraws.
                  </p>
                </div>
                <div className="space-y-2">
                  <h3 className="flex items-center gap-2 font-bold"><ScrollText className="h-4 w-4 text-primary" aria-hidden="true" /> Everything on the ledger</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Donations, tips, provider payouts, withdrawals, and refunds all post to the public ledger as
                    balanced entries, so the total cost of any campaign can be recomputed by anyone at any time.
                  </p>
                </div>
              </div>
              <Separator className="my-6" />
              <p className="text-sm text-muted-foreground">
                Refunds: donations are voluntary contributions, not purchases. If a campaign is found to be fraudulent
                or is cancelled, refunds are initiated to the original payment method and recorded on the ledger.
              </p>
            </CardContent>
          </Card>
        </section>

        <div className="flex flex-col gap-3 rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-700 p-8 text-white sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-extrabold">Start moving goodness forward</h2>
            <p className="mt-1 text-sm text-emerald-50">Launch a verified campaign, or back one that is already in motion.</p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button asChild variant="accent">
              <Link to="/start">Start a campaign</Link>
            </Button>
            <Button asChild className="border border-white/40 bg-white/10 text-white shadow-none hover:bg-white/20">
              <Link to="/campaigns">
                Explore campaigns
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
