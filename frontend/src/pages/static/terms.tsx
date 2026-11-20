export default function TermsOfServicePage() {
  return (
    <div>
      <section className="bg-gradient-to-b from-secondary/70 to-background" aria-labelledby="terms-heading">
        <div className="container py-12 lg:py-16">
          <h1 id="terms-heading" className="text-3xl font-extrabold tracking-tight sm:text-4xl">Terms of service</h1>
          <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
            The agreement between you and KINDORA when you use the platform. Last updated: 2025.
          </p>
        </div>
      </section>

      <div className="container py-10 lg:py-14">
        <article className="prose prose-emerald max-w-none prose-headings:font-extrabold prose-a:text-primary">
          <h2>1. Acceptance</h2>
          <p>
            By creating an account, starting a campaign, or making a donation on KINDORA, you agree to these terms, our
            privacy policy, and any provider terms that apply to your chosen payment method. If you do not agree,
            please do not use the platform. We may update these terms; continued use after an update constitutes
            acceptance.
          </p>

          <h2>2. Eligibility and accounts</h2>
          <p>
            You must be at least 18 years old to create an account, start a campaign, or donate. You are responsible
            for the accuracy of your registration details, for safeguarding your credentials, and for activity under
            your account. Accounts may be suspended for false information, fraud signals, or breach of these terms.
          </p>

          <h2>3. Campaigns and organizers</h2>
          <p>
            Organizers may publish campaigns only after passing identity verification and campaign review. Organizers
            agree that: information in the campaign, including story, budget, and beneficiary details, is truthful and
            not misleading; funds will be used for the stated purpose; supporting documents are genuine; and updates
            will be posted when material facts change. Prohibited campaigns include those for illegal activity, weapons,
            hate-based causes, fraudulent medical claims, financial scams, and anything that violates applicable law in
            Nigeria or the organizer&apos;s country. KINDORA may decline, pause, or remove any campaign, and may require
            documentation, at its discretion.
          </p>

          <h2>4. Donations and tips</h2>
          <p>
            Donations are voluntary contributions, not purchases or investments, and do not create any entitlement to
            goods, services, or returns. Donations are processed by third-party providers such as Paystack,
            Flutterwave, Stripe, and PayPal under their own terms. Donors may add an optional tip to support KINDORA&apos;s
            operation; tips are never required and are disclosed separately before checkout. Recurring donations repeat
            at the chosen frequency until cancelled by the donor. Refunds are issued where a campaign is found
            fraudulent, is cancelled, or where a refund is otherwise warranted under our refund process; provider
            timelines apply.
          </p>

          <h2>5. Fees</h2>
          <p>
            KINDORA charges no mandatory platform fee on donations. The platform is funded by optional donor tips.
            Payment providers charge processing fees under their published pricing, and withdrawal fees, where any
            apply, are disclosed to organizers before a payout is confirmed. KINDORA may change its fee structure with
            prospective effect and clear notice.
          </p>

          <h2>6. Public ledger and records</h2>
          <p>
            Donations, tips, matches, withdrawals, and refunds are posted to a public double-entry ledger. Public
            entries show amounts, references, and timestamps; donor names appear only where the donation is not
            anonymous. By using the platform you acknowledge that campaign financial records are public by design.
            You may not scrape, alter, or misrepresent ledger data.
          </p>

          <h2>7. Withdrawals</h2>
          <p>
            Withdrawals are requested by organizers, reviewed by KINDORA, and paid to verified bank accounts or mobile
            money wallets in the organizer&apos;s name. KINDORA may hold or reverse a payout where fraud is suspected, a
            report is under investigation, or documentation is incomplete. Organizers remain responsible for any taxes
            arising from funds they raise.
          </p>

          <h2>8. Content</h2>
          <p>
            You keep ownership of the content you publish. You grant KINDORA a worldwide, non-exclusive licence to
            display, reproduce, and adapt campaign content for the purposes of operating and promoting the platform.
            You confirm you have the rights to all media you upload and that it does not infringe third-party rights.
          </p>

          <h2>9. Liability</h2>
          <p>
            KINDORA verifies organizers and reviews campaigns but cannot guarantee outcomes of any fundraiser. To the
            maximum extent permitted by law, KINDORA is not liable for indirect or consequential losses, for the use of
            raised funds by organizers, or for provider outages. Our aggregate liability to you is limited to the
            amount of tips you paid to KINDORA in the twelve months before the claim. Nothing in these terms limits
            liability that cannot be limited by law.
          </p>

          <h2>10. Governing law</h2>
          <p>
            These terms are governed by the laws of the Federal Republic of Nigeria, and disputes will be resolved in
            the courts of Lagos, Nigeria, unless mandatory consumer law in your country of residence gives you a
            different forum. Questions about these terms can be sent to legal@kindora.org.
          </p>
        </article>
      </div>
    </div>
  );
}
