import { useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  BadgeCheck,
  Landmark,
  Receipt,
  ShieldAlert,
  TrendingUp,
  Wallet,
} from 'lucide-react';

import {
  useFinancialSummary,
  usePaymentReconciliation,
  type FinancialCurrencySummary,
  type PaymentAnomaly,
} from '@/api/financial-hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/shared';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/utils';

const PROVIDERS = ['PAYSTACK', 'FLUTTERWAVE', 'STRIPE', 'PAYPAL', 'MOCK', 'MANUAL'] as const;

/** yyyy-mm-dd for date inputs; defaults cover the trailing 30-day window. */
function isoDay(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

const ANOMALY_LABELS: Record<PaymentAnomaly, string> = {
  PROVIDER_MISMATCH: 'Provider mismatch',
  AMOUNT_UNVERIFIED: 'Fee unverified',
  REFERENCE_NOT_FOUND: 'Unknown references',
  UNKNOWN_EVENT: 'Unrecognized events',
  DUPLICATE: 'Duplicate deliveries',
  OK: 'Clean',
};

function anomalyVariant(anomaly: PaymentAnomaly) {
  switch (anomaly) {
    case 'PROVIDER_MISMATCH':
      return 'destructive' as const;
    case 'AMOUNT_UNVERIFIED':
    case 'REFERENCE_NOT_FOUND':
      return 'warning' as const;
    case 'UNKNOWN_EVENT':
      return 'muted' as const;
    case 'DUPLICATE':
      return 'secondary' as const;
    default:
      return 'success' as const;
  }
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'emerald' | 'amber' }) {
  return (
    <div className="rounded-xl border bg-background/40 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`mt-1.5 truncate text-lg font-bold ${
          tone === 'emerald' ? 'text-emerald-700' : tone === 'amber' ? 'text-amber-700' : ''
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function CurrencyTiles({ bucket }: { bucket: FinancialCurrencySummary }) {
  const cur = bucket.currency;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Tile
        label="Succeeded"
        value={formatMoney(bucket.donationsSucceeded.amountMinor, cur)}
        hint={`${bucket.donationsSucceeded.count.toLocaleString()} donations`}
        tone="emerald"
      />
      <Tile
        label="Pending"
        value={formatMoney(bucket.donationsPending.amountMinor, cur)}
        hint={`${bucket.donationsPending.count.toLocaleString()} awaiting confirmation`}
        tone={bucket.donationsPending.count > 0 ? 'amber' : undefined}
      />
      <Tile
        label="Failed"
        value={bucket.donationsFailed.count.toLocaleString()}
        hint="Terminal failures in range"
      />
      <Tile
        label="Refunded"
        value={formatMoney(bucket.donationsRefunded.amountMinor, cur)}
        hint={`${bucket.donationsRefunded.count.toLocaleString()} donations (face value)`}
      />
      <Tile
        label="Provider fees"
        value={formatMoney(bucket.donationsSucceeded.feesMinor, cur)}
        hint={`Ledger expense ${formatMoney(bucket.providerFeesMinor, cur)}`}
      />
      <Tile
        label="Platform revenue"
        value={formatMoney(bucket.platformRevenueMinor, cur)}
        hint={`Tips in range ${formatMoney(bucket.donationsSucceeded.tipsMinor, cur)}`}
        tone="emerald"
      />
      <Tile
        label="Campaign liabilities"
        value={formatMoney(bucket.campaignLiabilityMinor, cur)}
        hint="Ledger 2000:CAMPAIGN balances"
      />
      <Tile
        label="Reserved for payouts"
        value={formatMoney(bucket.reservedForWithdrawalsMinor, cur)}
        hint="Outstanding payout liability (incl. approved)"
        tone="amber"
      />
      <Tile
        label="Paid payouts"
        value={formatMoney(bucket.paidWithdrawalsMinor, cur)}
        hint="Settled gross, all time"
      />
      <Tile
        label="Clearing balance"
        value={formatMoney(bucket.clearingMinor, cur)}
        hint="Provider funds in transit (1100)"
      />
      <Tile
        label="Recurring active"
        value={bucket.recurringActive.count.toLocaleString()}
        hint={`Schedule amounts ${formatMoney(bucket.recurringActive.monthlyMinor, cur)}`}
      />
      <Tile
        label="Recurring failures"
        value={bucket.recurringFailures.count.toLocaleString()}
        hint={bucket.recurringFailures.lastFailureAt ? `Last ${formatDate(bucket.recurringFailures.lastFailureAt)}` : 'No recent failures'}
        tone={bucket.recurringFailures.count > 0 ? 'amber' : undefined}
      />
    </div>
  );
}

export default function AdminFinancialPage() {
  const [from, setFrom] = useState(isoDay(29));
  const [to, setTo] = useState(isoDay(0));
  const [provider, setProvider] = useState<string>('ALL');
  const [currencyTab, setCurrencyTab] = useState<string>('');

  const filters = { from, to, ...(provider !== 'ALL' ? { provider } : {}) };
  const { data, isLoading, isError, refetch, isFetching } = useFinancialSummary(filters);
  const payments = usePaymentReconciliation({ from, to });

  const buckets = data?.currencies ?? [];
  const active = buckets.find((b) => b.currency === currencyTab) ?? buckets[0];
  const anomalyCounts = payments.data?.counts;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Financial centre</h1>
          <p className="text-sm text-muted-foreground">
            Money control across donations, payouts, revenue and the double-entry ledger. Currencies are never combined.
          </p>
        </div>
        <Button
          asChild
          variant="outline"
          className="min-h-11 shrink-0"
        >
          <Link to="/admin/financial/reconciliation">
            <ShieldAlert className="h-4 w-4" aria-hidden="true" />
            Reconciliation
          </Link>
        </Button>
      </div>

      {/* Filters */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Reporting window</CardTitle>
          <CardDescription>
            Donation buckets cover this window (max 1 year). Balances and reservations are point-in-time.
            {data && ` Showing ${formatDate(data.from)} – ${formatDate(data.to)}.`}
            {isFetching && !isLoading && ' Refreshing…'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="financial-from">From</Label>
            <Input
              id="financial-from"
              type="date"
              value={from}
              max={to}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFrom(e.target.value)}
              className="min-h-11"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="financial-to">To</Label>
            <Input
              id="financial-to"
              type="date"
              value={to}
              min={from}
              max={isoDay(0)}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTo(e.target.value)}
              className="min-h-11"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="financial-provider">Provider</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger id="financial-provider" className="min-h-11">
                <SelectValue placeholder="All providers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All providers</SelectItem>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Anomaly + dispute signals */}
      <div className="flex flex-wrap items-center gap-2" aria-label="Payment anomaly counters">
        {anomalyCounts ? (
          (Object.keys(ANOMALY_LABELS) as PaymentAnomaly[])
            .filter((a) => a !== 'OK' && anomalyCounts[a] > 0)
            .map((a) => (
              <Link
                key={a}
                to="/admin/financial/reconciliation"
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
                aria-label={`${ANOMALY_LABELS[a]}: ${anomalyCounts[a]}`}
              >
                <Badge variant={anomalyVariant(a)} className="cursor-pointer px-3 py-1">
                  <AlertTriangle className="mr-1 h-3 w-3" aria-hidden="true" />
                  {ANOMALY_LABELS[a]}: {anomalyCounts[a].toLocaleString()}
                </Badge>
              </Link>
            ))
        ) : payments.isLoading ? (
          <Skeleton className="h-7 w-40" />
        ) : null}
        {anomalyCounts && Object.entries(anomalyCounts).every(([k, v]) => k === 'OK' || v === 0) && (
          <Badge variant="success" className="px-3 py-1">
            <BadgeCheck className="mr-1 h-3 w-3" aria-hidden="true" />
            No payment anomalies in range
          </Badge>
        )}
        {data && data.disputesOpen > 0 && (
          <Badge variant="destructive" className="px-3 py-1">
            <ShieldAlert className="mr-1 h-3 w-3" aria-hidden="true" />
            {data.disputesOpen} provider dispute {data.disputesOpen === 1 ? 'event' : 'events'} (all currencies)
          </Badge>
        )}
      </div>

      {/* Per-currency summary */}
      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={Landmark}
          title="Could not load the financial summary"
          description="Something went wrong while aggregating the money views."
          action={<Button onClick={() => void refetch()}>Try again</Button>}
        />
      ) : buckets.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="No financial activity"
          description="No currencies with donations, payouts or ledger activity for this window."
        />
      ) : (
        <Tabs value={active?.currency ?? ''} onValueChange={setCurrencyTab}>
          <TabsList aria-label="Currency">
            {buckets.map((b) => (
              <TabsTrigger key={b.currency} value={b.currency}>
                {b.currency}
              </TabsTrigger>
            ))}
          </TabsList>
          {active && (
            <div className="mt-4" role="region" aria-label={`${active.currency} summary`}>
              <div className="mb-3 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm font-semibold">{active.currency} control view</p>
                <Badge variant="muted">per-currency only — no cross-currency totals</Badge>
              </div>
              <CurrencyTiles bucket={active} />
            </div>
          )}
        </Tabs>
      )}

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Receipt className="h-3.5 w-3.5" aria-hidden="true" />
        Recurring "schedule amounts" sum each plan's configured amount without per-month normalisation. Refund figures
        carry donation face value; provider refund proceeds are exported in the refunds report.
      </p>
    </div>
  );
}
