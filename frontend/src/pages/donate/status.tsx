import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Clock3, HelpCircle, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { useDonationStatus } from '@/api/hooks';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/utils';

export default function DonationStatusPage() {
  const [searchParams] = useSearchParams();
  const reference = searchParams.get('ref') ?? searchParams.get('reference') ?? '';
  const provider = searchParams.get('provider') ?? 'PAYSTACK';
  const isMock = searchParams.get('mock') === '1';

  const status = useDonationStatus(provider, reference);

  /* Missing reference */
  if (!reference) {
    return (
      <StatusShell>
        <StatusIcon icon={HelpCircle} tone="muted" />
        <h1 className="text-2xl font-extrabold tracking-tight">Missing payment reference</h1>
        <p className="max-w-md text-muted-foreground">
          This page needs a payment reference to check your donation. If you came here from a payment provider, please
          return to the campaign and try again.
        </p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          <Button asChild>
            <Link to="/campaigns">Explore campaigns</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/">Go home</Link>
          </Button>
        </div>
      </StatusShell>
    );
  }

  /* Loading */
  if (status.isLoading) {
    return (
      <StatusShell>
        <div className="w-full max-w-md space-y-4" aria-busy="true">
          <Skeleton className="mx-auto h-16 w-16 rounded-full" />
          <Skeleton className="mx-auto h-8 w-3/4" />
          <Skeleton className="mx-auto h-4 w-1/2" />
          <Skeleton className="mx-auto h-24 w-full rounded-2xl" />
        </div>
      </StatusShell>
    );
  }

  const donation = status.data;
  const amount = donation ? formatMoney(donation.amount, donation.currency) : '';
  const tip = donation && Number(donation.tipAmount) > 0 ? formatMoney(donation.tipAmount, donation.currency) : '';

  /* Not found yet */
  if (status.isError || !donation) {
    return (
      <StatusShell>
        <StatusIcon icon={HelpCircle} tone="muted" />
        <h1 className="text-2xl font-extrabold tracking-tight">We could not verify this payment yet</h1>
        <p className="max-w-md text-muted-foreground">
          Reference <span className="font-mono font-semibold text-foreground">{reference}</span> has no confirmed
          status with {provider === 'MOCK' ? 'the demo checkout' : provider}. If you just completed a bank transfer,
          it can take a few minutes to appear. This page will update automatically while it is open.
        </p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          <Button asChild variant="outline">
            <Link to="/campaigns">Explore campaigns</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link to="/">Go home</Link>
          </Button>
        </div>
      </StatusShell>
    );
  }

  /* Success */
  if (donation.status === 'SUCCEEDED') {
    return (
      <StatusShell>
        <StatusIcon icon={CheckCircle2} tone="success" />
        <h1 className="text-2xl font-extrabold tracking-tight">Your donation is confirmed</h1>
        <p className="max-w-md text-muted-foreground">
          Thank you for moving goodness forward. Your gift has been posted to the KINDORA public ledger.
        </p>
        <Card className="w-full max-w-md text-left">
          <CardContent className="space-y-3 p-6">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-muted-foreground">Amount</span>
              <span className="text-lg font-extrabold text-primary">
                {amount}
                {tip && <span className="ml-1 text-xs font-semibold text-muted-foreground">+ {tip} tip</span>}
              </span>
            </div>
            {donation.campaign && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-muted-foreground">Campaign</span>
                <span className="text-right font-semibold">{donation.campaign.title}</span>
              </div>
            )}
            {donation.receiptNumber && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-muted-foreground">Receipt</span>
                <span className="font-mono text-sm font-semibold">{donation.receiptNumber}</span>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-muted-foreground">Reference</span>
              <span className="font-mono text-sm">{donation.publicRef}</span>
            </div>
            {donation.succeededAt && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-muted-foreground">Confirmed</span>
                <span className="text-sm">{formatDate(donation.succeededAt)}</span>
              </div>
            )}
            <Separator />
            {donation.campaign ? (
              <Button asChild className="w-full">
                <Link to={`/campaigns/${donation.campaign.slug}`}>
                  Back to the campaign
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            ) : (
              <Button asChild className="w-full">
                <Link to="/campaigns">Explore more causes</Link>
              </Button>
            )}
          </CardContent>
        </Card>
        {isMock && (
          <Badge variant="warning" className="mt-1">
            Demo donation — no real payment was processed
          </Badge>
        )}
      </StatusShell>
    );
  }

  /* Failed or cancelled */
  if (donation.status === 'FAILED' || donation.status === 'CANCELLED') {
    return (
      <StatusShell>
        <StatusIcon icon={XCircle} tone="destructive" />
        <h1 className="text-2xl font-extrabold tracking-tight">Payment was not completed</h1>
        <p className="max-w-md text-muted-foreground">
          {provider === 'MOCK' ? 'The demo checkout' : provider} reported the payment as
          {' '}{donation.status.toLowerCase()}. No money left your account for this reference. You can safely try again.
        </p>
        {donation.failureReason && (
          <p className="max-w-md rounded-xl bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive">
            Reason from the provider: {donation.failureReason}
          </p>
        )}
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          {donation.campaign && (
            <Button asChild>
              <Link to={`/donate/${donation.campaign.slug}`}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Try again
              </Link>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link to="/campaigns">Explore campaigns</Link>
          </Button>
        </div>
      </StatusShell>
    );
  }

  /* Refunded */
  if (donation.status === 'REFUNDED' || donation.status === 'PARTIALLY_REFUNDED') {
    return (
      <StatusShell>
        <StatusIcon icon={CheckCircle2} tone="muted" />
        <h1 className="text-2xl font-extrabold tracking-tight">This donation was refunded</h1>
        <p className="max-w-md text-muted-foreground">
          {amount} for reference {donation.publicRef} has been refunded. The refund is recorded on the public ledger and
          may take a few business days to appear on your statement, depending on your payment provider.
        </p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          <Button asChild variant="outline">
            <Link to="/impact">View the public ledger</Link>
          </Button>
        </div>
      </StatusShell>
    );
  }

  /* Pending — never presented as a success: the donation only becomes
     SUCCEEDED after the provider verification completes, and the receipt is
     issued only at that point. */
  const providerName = provider === 'MOCK' ? 'the demo checkout' : provider;
  return (
    <StatusShell>
      <StatusIcon icon={Clock3} tone="pending" />
      <h1 className="text-2xl font-extrabold tracking-tight">Awaiting confirmation from {providerName}</h1>
      <p className="max-w-md text-muted-foreground">
        Your payment of {amount || 'your donation'} has been received and is now waiting for {providerName} to
        confirm it. This is not a receipt — the donation only completes once the provider verifies the payment. This
        page updates automatically, so you can safely leave it open.
      </p>
      <Card className="w-full max-w-md text-left">
        <CardContent className="space-y-3 p-6">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-muted-foreground">Reference</span>
            <span className="font-mono text-sm font-semibold">{donation.publicRef}</span>
          </div>
          {donation.campaign && (
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-muted-foreground">Campaign</span>
              <span className="text-right font-semibold">{donation.campaign.title}</span>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-muted-foreground">Status</span>
            <span className="text-sm font-semibold">Awaiting payment confirmation</span>
          </div>
          <Separator />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Bank transfers can take a few minutes (occasionally longer on weekends) before the provider confirms them.
            Once confirmed, your donation is posted to the KINDORA ledger and the receipt becomes available. If the
            provider rejects the payment, nothing is charged and you can try again.
          </p>
        </CardContent>
      </Card>
      {isMock && (
        <Badge variant="warning" className="mt-1">
          Demo donation — status updates are simulated
        </Badge>
      )}
    </StatusShell>
  );
}

function StatusShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="container flex min-h-[70dvh] flex-col items-center justify-center gap-4 py-16 text-center">
      {children}
    </div>
  );
}

function StatusIcon({
  icon: Icon,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: 'success' | 'destructive' | 'pending' | 'muted';
}) {
  const tones: Record<typeof tone, string> = {
    success: 'bg-emerald-100 text-emerald-700',
    destructive: 'bg-red-100 text-red-700',
    pending: 'bg-amber-100 text-amber-700',
    muted: 'bg-muted text-muted-foreground',
  };
  return (
    <span className={`flex h-16 w-16 items-center justify-center rounded-full ${tones[tone]}`} aria-hidden="true">
      <Icon className="h-8 w-8" />
    </span>
  );
}
