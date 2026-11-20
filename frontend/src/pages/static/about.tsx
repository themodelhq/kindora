import { Link } from 'react-router-dom';
import { BadgeCheck, HandCoins, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function AboutPage() {
  return (
    <div>
      <section className="bg-gradient-to-b from-secondary/70 to-background" aria-labelledby="about-heading">
        <div className="container py-12 lg:py-16">
          <h1 id="about-heading" className="text-3xl font-extrabold tracking-tight sm:text-4xl">
            About KINDORA
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
            Goodness, in motion. KINDORA is a crowdfunding platform built for people who want to give — and want to be
            able to check where their money went.
          </p>
        </div>
      </section>

      <div className="container py-10 lg:py-14">
        <article className="prose prose-emerald max-w-none prose-headings:font-extrabold prose-a:text-primary">
          <h2>Why we exist</h2>
          <p>
            Every day, families in Nigeria and across Africa raise money online for medical care, school fees, clean
            water, and emergencies. Online fundraising works — but too often donors are asked to hand over money and
            simply hope. Screenshots, unverifiable stories, and silent fund pages make it easy for genuine organizers to
            be doubted and for dishonest ones to go unnoticed.
          </p>
          <p>
            KINDORA was built to solve that trust problem. We believe crowdfunding works best when the money trail is
            as visible as the story. So we designed the platform around a public record of everything: who is raising,
            who gave, what was spent, and what was paid out.
          </p>

          <h2>Our transparency model</h2>
          <p>
            Transparency on KINDORA is not a marketing word. It is a set of concrete mechanisms built into the product:
          </p>
          <ul>
            <li>
              <strong>Verified organizers.</strong> No campaign is published until its organizer has passed identity
              verification and our review team has approved the story, budget, and supporting documents. Organizers for
              registered nonprofits provide registration details as well.
            </li>
            <li>
              <strong>A public double-entry ledger.</strong> Every donation, optional tip, sponsor match, and organizer
              payout is posted to a double-entry ledger. Debits and credits always balance, and anyone can inspect the
              entries on the <Link to="/impact">public impact page</Link> or on a campaign&apos;s Transparency tab.
            </li>
            <li>
              <strong>Visible withdrawals.</strong> When organizers withdraw funds, the payout is recorded with a
              reference and appears in the campaign&apos;s public record. Donors can see money leaving the platform,
              not just money arriving.
            </li>
            <li>
              <strong>Matching pools.</strong> Sponsors fund pools that multiply donations while funds last. Each match
              is a separate ledger transaction, so amplified gifts are always distinguishable from direct ones.
            </li>
            <li>
              <strong>Community reporting.</strong> Every campaign carries a report action. Reports go to our trust and
              safety team and are reviewed against the campaign&apos;s verified documents.
            </li>
          </ul>

          <h2>How KINDORA sustains itself</h2>
          <p>
            KINDORA does not charge a mandatory platform fee. Donors can leave an optional tip at checkout, and that is
            how we keep the lights on. Payment providers (such as Paystack, Flutterwave, Stripe, and PayPal) charge
            their own processing fees, which are disclosed before you confirm a payment. Organizers see the applicable
            fees before requesting a withdrawal.
          </p>

          <h2>What we do and what we do not do</h2>
          <p>
            We verify organizers, review campaigns, keep the ledger, process payments through regulated providers, and
            investigate every report. We do not touch donations held for causes, we do not decide how organizers spend
            the funds they raise — that is what published receipts and the ledger are for — and we do not sell donor
            data. When something goes wrong, we refund where the evidence supports it and publish the outcome.
          </p>

          <h2>Where we operate</h2>
          <p>
            KINDORA launches in Nigeria and supports organizers and donors across Ghana, Kenya, South Africa, the
            United Kingdom, the United States, and beyond. Currency and payment methods are matched to each campaign&apos;s
            country, and all records remain visible regardless of currency.
          </p>
        </article>

        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {[
            {
              icon: BadgeCheck,
              title: 'Verification first',
              text: 'Identity and document checks happen before a campaign can raise a single naira.',
            },
            {
              icon: ScrollText,
              title: 'Ledger always',
              text: 'Balanced double-entry records for every movement of money, open to everyone.',
            },
            {
              icon: HandCoins,
              title: 'Tips, not tolls',
              text: 'No mandatory platform fee. Optional tips and disclosed provider fees only.',
            },
          ].map((item) => (
            <Card key={item.title}>
              <CardContent className="space-y-3 p-6">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10" aria-hidden="true">
                  <item.icon className="h-5 w-5 text-primary" />
                </span>
                <h3 className="font-bold">{item.title}</h3>
                <p className="text-sm text-muted-foreground">{item.text}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 rounded-2xl bg-secondary/60 p-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-semibold">Ready to see the ledger in action?</p>
          <Button asChild>
            <Link to="/impact">Open the public impact page</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
