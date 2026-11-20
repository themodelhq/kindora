export default function PrivacyPolicyPage() {
  return (
    <div>
      <section className="bg-gradient-to-b from-secondary/70 to-background" aria-labelledby="privacy-heading">
        <div className="container py-12 lg:py-16">
          <h1 id="privacy-heading" className="text-3xl font-extrabold tracking-tight sm:text-4xl">Privacy policy</h1>
          <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
            How KINDORA collects, uses, protects, and retains personal data. Last updated: 2025.
          </p>
        </div>
      </section>

      <div className="container py-10 lg:py-14">
        <article className="prose prose-emerald max-w-none prose-headings:font-extrabold prose-a:text-primary">
          <h2>1. Who we are</h2>
          <p>
            KINDORA is a crowdfunding platform operated from Lagos, Nigeria, that connects donors with verified
            organizers of fundraising campaigns. We act as the data controller for personal data collected through the
            platform, and we comply with the Nigeria Data Protection Regulation (NDPR) and, where applicable, the EU
            General Data Protection Regulation (GDPR).
          </p>

          <h2>2. Data we collect</h2>
          <ul>
            <li>
              <strong>Account data:</strong> name, email address, hashed password, country, and (optionally) phone
              number and avatar. Organizer verification adds identity documents and organization registration details,
              processed solely for review.
            </li>
            <li>
              <strong>Donation data:</strong> donation amounts, tips, messages, anonymity preferences, receipts, and
              the payment reference returned by the provider. Full payment card details are never stored on KINDORA
              servers; they are collected and processed directly by our payment providers (Paystack, Flutterwave,
              Stripe, and PayPal).
            </li>
            <li>
              <strong>Technical data:</strong> IP address, device and browser type, and session records used for
              security, fraud prevention, and service reliability.
            </li>
            <li>
              <strong>Support data:</strong> campaign reports and messages you send to our trust and safety team.
            </li>
          </ul>

          <h2>3. How we use data</h2>
          <p>
            We process personal data to operate the platform (creating accounts, publishing campaigns, processing
            donations through providers, paying out withdrawals), to keep it safe (identity verification, fraud
            monitoring, abuse investigation), to maintain the public ledger (posting donation, tip, match, and payout
            records), and to communicate with you (receipts, campaign updates you follow, security notices, and
            responses to reports). Marketing emails are sent only with your consent and can be stopped at any time.
          </p>

          <h2>4. Legal bases</h2>
          <p>
            Under the NDPR and GDPR we rely on: performance of a contract (providing the service you requested);
            legitimate interests (platform security and fraud prevention); consent (optional tips preferences,
            marketing, and optional profile information); and legal obligations (financial record-keeping and responses
            to lawful requests).
          </p>

          <h2>5. Sharing</h2>
          <p>
            We share the minimum necessary data with: payment providers, to process donations and payouts; organizers
            of campaigns you support, who see your display name and message unless you give anonymously; cloud and
            email infrastructure providers under contract; and competent authorities, only where legally required.
            Public ledger entries contain donation amounts and references; anonymous donations exclude donor names. We
            do not sell personal data.
          </p>

          <h2>6. Security</h2>
          <p>
            Data is encrypted in transit with TLS. Access tokens are held in memory and refreshed via httpOnly cookies;
            passwords are hashed; staff access to verification documents is restricted and logged. No system is
            perfectly secure, so we maintain an incident response process and will notify affected users and regulators
            where breaches occur, as required by law.
          </p>

          <h2>7. Data retention</h2>
          <p>
            Transaction and financial records are retained for at least six (6) years to meet Nigerian record-keeping
            obligations and to preserve the integrity of the public audit trail. Account data is retained while your
            account is active; if you delete your account, personal identifiers are removed or irreversibly
            anonymized, while ledger entries remain in anonymized form because they are public records of money
            movement. Verification documents are deleted after review unless retention is required by law.
          </p>

          <h2>8. Your rights</h2>
          <p>
            You may request access to your data, correction of inaccuracies, deletion where retention rules allow,
            restriction of processing, portability of account data, and objection to processing based on legitimate
            interests. You may also withdraw consent for marketing at any time. To exercise any right, contact us using
            the details below; we respond within the timelines set by the NDPR and GDPR.
          </p>

          <h2>9. International transfers</h2>
          <p>
            Our providers may process data outside Nigeria. Where that happens, we rely on appropriate safeguards such
            as contractual clauses and provider certifications to protect your data to the standard required by law.
          </p>

          <h2>10. Contact and changes</h2>
          <p>
            For privacy questions or requests, email privacy@kindora.org or write to the KINDORA trust and safety team,
            Lagos, Nigeria. If you are unsatisfied with our response you may complain to the relevant data protection
            authority. We may update this policy as the service evolves; material changes will be announced on the
            platform before they take effect.
          </p>
        </article>
      </div>
    </div>
  );
}
