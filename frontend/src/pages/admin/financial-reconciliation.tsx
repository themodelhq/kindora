import { useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  BadgeCheck,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  downloadFinancialCsv,
  useLedgerIntegrity,
  usePaymentReconciliation,
  useWithdrawalReconciliation,
  type FinancialReportType,
  type PaymentAnomaly,
  type WithdrawalReconciliationRow,
} from '@/api/financial-hooks';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/shared';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/utils';

const PROVIDERS = ['PAYSTACK', 'FLUTTERWAVE', 'STRIPE', 'PAYPAL', 'MOCK', 'MANUAL'] as const;
const WEBHOOK_STATUSES = ['RECEIVED', 'PROCESSED', 'FAILED', 'DUPLICATE'] as const;
const REPORTS: { type: FinancialReportType; label: string; description: string }[] = [
  { type: 'daily-closing', label: 'Daily closing', description: 'Per currency per day, last 30 days' },
  { type: 'campaign-balances', label: 'Campaign balances', description: 'Raised vs ledger vs reservations' },
  { type: 'withdrawals', label: 'Withdrawals', description: 'Full payout export incl. provider metadata' },
  { type: 'refunds', label: 'Refunds', description: 'Refund rows with donation references' },
  { type: 'platform-fees', label: 'Platform fees', description: 'Verified provider processing fees' },
];

function isoDay(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

const ANOMALY_BADGES: Record<PaymentAnomaly, { label: string; variant: BadgeProps['variant'] }> = {
  PROVIDER_MISMATCH: { label: 'Provider mismatch', variant: 'destructive' },
  AMOUNT_UNVERIFIED: { label: 'Fee unverified', variant: 'warning' },
  REFERENCE_NOT_FOUND: { label: 'Unknown reference', variant: 'warning' },
  UNKNOWN_EVENT: { label: 'Unrecognized event', variant: 'muted' },
  DUPLICATE: { label: 'Duplicate', variant: 'secondary' },
  OK: { label: 'OK', variant: 'success' },
};

function webhookVariant(status: string): BadgeProps['variant'] {
  switch (status) {
    case 'PROCESSED':
      return 'success';
    case 'DUPLICATE':
      return 'secondary';
    case 'FAILED':
      return 'destructive';
    default:
      return 'muted';
  }
}

function withdrawalStatusVariant(status: string): BadgeProps['variant'] {
  switch (status) {
    case 'PAID':
      return 'success';
    case 'FAILED':
    case 'REJECTED':
      return 'destructive';
    case 'PENDING':
      return 'warning';
    case 'APPROVED':
    case 'PROCESSING':
      return 'secondary';
    default:
      return 'muted';
  }
}

// ---------- payments tab ----------

function PaymentsTab() {
  const [from, setFrom] = useState(isoDay(29));
  const [to, setTo] = useState(isoDay(0));
  const [provider, setProvider] = useState('ALL');
  const [status, setStatus] = useState('ANY');
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch, isFetching } = usePaymentReconciliation({
    from,
    to,
    ...(provider !== 'ALL' ? { provider } : {}),
    ...(status !== 'ANY' ? { status } : {}),
    page,
  });

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;
  const canPrev = page > 1;
  const canNext = page * pageSize < total;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 rounded-2xl border bg-card p-4 shadow-soft sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="payments-from">From</Label>
          <Input
            id="payments-from"
            type="date"
            value={from}
            max={to}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setFrom(e.target.value);
              setPage(1);
            }}
            className="min-h-11"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="payments-to">To</Label>
          <Input
            id="payments-to"
            type="date"
            value={to}
            min={from}
            max={isoDay(0)}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setTo(e.target.value);
              setPage(1);
            }}
            className="min-h-11"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="payments-provider">Provider</Label>
          <Select
            value={provider}
            onValueChange={(v) => {
              setProvider(v);
              setPage(1);
            }}
          >
            <SelectTrigger id="payments-provider" className="min-h-11">
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
        <div className="space-y-2">
          <Label htmlFor="payments-status">Webhook status</Label>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          >
            <SelectTrigger id="payments-status" className="min-h-11">
              <SelectValue placeholder="Any status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ANY">Any status</SelectItem>
              {WEBHOOK_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Anomaly counts over the whole period */}
      {data && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Anomaly counts">
          {(Object.keys(ANOMALY_BADGES) as PaymentAnomaly[]).map((a) => (
            <Badge
              key={a}
              variant={a === 'OK' ? 'muted' : ANOMALY_BADGES[a].variant}
              className={a === 'OK' && data.counts[a] === 0 ? 'opacity-50' : ''}
            >
              {ANOMALY_BADGES[a].label}: {data.counts[a].toLocaleString()}
            </Badge>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={ShieldAlert}
          title="Could not load payment reconciliation"
          description="Something went wrong while comparing webhook deliveries with donations."
          action={<Button onClick={() => void refetch()}>Try again</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={BadgeCheck}
          title="No webhook deliveries in range"
          description="Provider webhook deliveries for this window will appear here with their anomaly classification."
        />
      ) : (
        <>
          <div className="max-h-96 overflow-y-auto rounded-2xl border bg-card shadow-soft scrollbar-thin">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Donation state</TableHead>
                  <TableHead>Handling</TableHead>
                  <TableHead>Anomaly</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(row.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <span>{row.provider}</span>
                        {!row.signatureValid && (
                          <Badge variant="destructive" className="w-fit">
                            Bad signature
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[12rem]">
                      <span className="block truncate font-mono text-xs">{row.eventType ?? '—'}</span>
                    </TableCell>
                    <TableCell className="max-w-[12rem]">
                      <code className="block truncate font-mono text-xs">{row.reference ?? '—'}</code>
                      {row.eventId && <code className="block truncate font-mono text-[10px] text-muted-foreground">{row.eventId}</code>}
                    </TableCell>
                    <TableCell>
                      {row.donationState ? (
                        <div className="space-y-1">
                          <code className="block font-mono text-xs">{row.donationState.publicRef}</code>
                          <Badge variant="muted">{row.donationState.status}</Badge>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Badge variant={webhookVariant(row.status)}>{row.status}</Badge>
                        <span className="block max-w-[12rem] truncate font-mono text-[10px] text-muted-foreground">
                          {row.handledAction ?? '—'}
                        </span>
                        {row.processedAt && (
                          <span className="block text-[10px] text-muted-foreground">{formatDate(row.processedAt)}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={ANOMALY_BADGES[row.anomaly].variant}>{ANOMALY_BADGES[row.anomaly].label}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Page {page} of {Math.max(1, Math.ceil(total / pageSize))} · {total} deliveries
              {isFetching && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={!canPrev || isFetching}
                className="min-h-11"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                Previous
              </Button>
              <Button
                variant="outline"
                onClick={() => setPage((p) => p + 1)}
                disabled={!canNext || isFetching}
                className="min-h-11"
              >
                Next
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- withdrawals tab ----------

function WithdrawalsTab() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, refetch, isFetching } = useWithdrawalReconciliation(page);

  const rows: WithdrawalReconciliationRow[] = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;
  const canPrev = page > 1;
  const canNext = page * pageSize < total;
  const summary = data?.summary;

  return (
    <div className="space-y-4">
      {summary && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Withdrawal reconciliation summary">
          <Badge variant="success" className="px-3 py-1">
            Paid: {summary.paid.toLocaleString()}
          </Badge>
          <Badge variant={summary.awaitingReconciliation > 0 ? 'warning' : 'muted'} className="px-3 py-1">
            Awaiting reconciliation: {summary.awaitingReconciliation.toLocaleString()}
          </Badge>
          <Badge variant="destructive" className="px-3 py-1">
            Failed: {summary.failed.toLocaleString()}
          </Badge>
          <Badge variant="destructive" className="px-3 py-1">
            Rejected: {summary.rejected.toLocaleString()}
          </Badge>
          {Object.entries(summary.outstandingReservationMinor).map(([currency, minor]) => (
            <Badge key={currency} variant="secondary" className="px-3 py-1">
              Reserved {currency}: {formatMoney(minor, currency)}
            </Badge>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={Wallet}
          title="Could not load withdrawal reconciliation"
          description="Something went wrong while loading payout settlement data."
          action={<Button onClick={() => void refetch()}>Try again</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="No withdrawals yet"
          description="Payouts will appear here with their reconciliation state."
        />
      ) : (
        <>
          <div className="max-h-96 overflow-y-auto rounded-2xl border bg-card shadow-soft scrollbar-thin">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Amount / net</TableHead>
                  <TableHead>Payout provider</TableHead>
                  <TableHead>Settlement</TableHead>
                  <TableHead>Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell>
                      <code className="font-mono text-xs">{w.publicRef}</code>
                    </TableCell>
                    <TableCell className="max-w-[12rem]">
                      <span className="block truncate text-muted-foreground">{w.campaign?.title ?? '—'}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={withdrawalStatusVariant(w.status)}>{w.status}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatMoney(w.amountMinor, w.currency)}
                      <span className="block text-xs text-muted-foreground">net {formatMoney(w.netAmountMinor, w.currency)}</span>
                    </TableCell>
                    <TableCell>
                      {w.payoutProvider ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="max-w-[12rem]">
                      {w.paidAt ? (
                        <div className="space-y-0.5">
                          <span className="block text-xs">Paid {formatDate(w.paidAt)}</span>
                          {w.providerTransferRef && (
                            <code className="block truncate font-mono text-[10px] text-muted-foreground">{w.providerTransferRef}</code>
                          )}
                          {w.payoutProviderTxnId && (
                            <code className="block truncate font-mono text-[10px] text-muted-foreground">{w.payoutProviderTxnId}</code>
                          )}
                          <span className="block text-[10px] text-muted-foreground">
                            {w.reconciledAt ? `Reconciled ${formatDate(w.reconciledAt)}` : 'Not reconciled'}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">Not settled</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        {w.needsReconciliation && (
                          <Badge variant="warning" className="w-fit">
                            Needs reconciliation
                          </Badge>
                        )}
                        {w.missingEvidence && (
                          <Badge variant="destructive" className="w-fit">
                            Missing evidence
                          </Badge>
                        )}
                        {!w.needsReconciliation && !w.missingEvidence && <span className="text-muted-foreground">—</span>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Page {page} of {Math.max(1, Math.ceil(total / pageSize))} · {total} payouts
              {isFetching && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={!canPrev || isFetching}
                className="min-h-11"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                Previous
              </Button>
              <Button
                variant="outline"
                onClick={() => setPage((p) => p + 1)}
                disabled={!canNext || isFetching}
                className="min-h-11"
              >
                Next
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- ledger integrity tab ----------

function LedgerTab() {
  const { data, isLoading, isError, refetch, isFetching } = useLedgerIntegrity();

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base">Ledger integrity sweep</CardTitle>
              <CardDescription>
                Read-only checks: debit/credit balance per transaction, campaign liability vs raised amount, charge
                totals, reference uniqueness. Never auto-fixes anything.
                {data && ` Last run ${formatDate(data.checkedAt)} over ${data.transactionsChecked.toLocaleString()} transactions.`}
              </CardDescription>
            </div>
            <Button onClick={() => void refetch()} disabled={isFetching} className="min-h-11 shrink-0">
              {isFetching || isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
              )}
              Run check
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          ) : isError ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Could not run the integrity sweep. Try again.
            </p>
          ) : !data ? null : data.ok ? (
            <div className="flex items-center gap-3 rounded-xl bg-emerald-50 px-4 py-3 text-emerald-900" role="status">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100">
                <BadgeCheck className="h-4 w-4 text-emerald-700" aria-hidden="true" />
              </span>
              <p className="text-sm font-medium">
                Ledger is consistent — {data.transactionsChecked.toLocaleString()} transactions balanced, campaign
                liabilities reconciled, charge totals intact.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 text-amber-900" role="alert">
                <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
                <p className="text-sm font-medium">
                  Violations found — investigate below. This tool never mutates data.
                </p>
              </div>

              {data.violations.unbalancedTxns.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold">Unbalanced transactions (debit ≠ credit)</h4>
                  <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border p-3 font-mono text-xs scrollbar-thin">
                    {data.violations.unbalancedTxns.map((ref) => (
                      <div key={ref} className="py-0.5">{ref}</div>
                    ))}
                  </div>
                </div>
              )}

              {data.violations.campaignMismatches.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold">
                    Campaign liability mismatches (ledger ≠ raisedAmount − paid gross)
                  </h4>
                  <div className="mt-2 rounded-xl border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Campaign</TableHead>
                          <TableHead>Currency</TableHead>
                          <TableHead>Ledger balance</TableHead>
                          <TableHead>Expected</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.violations.campaignMismatches.map((m) => (
                          <TableRow key={`${m.campaignId}-${m.currency}`}>
                            <TableCell>
                              <code className="font-mono text-xs">{m.campaignId}</code>
                            </TableCell>
                            <TableCell>{m.currency}</TableCell>
                            <TableCell>{formatMoney(m.ledgerBalanceMinor, m.currency)}</TableCell>
                            <TableCell>{formatMoney(m.expectedMinor, m.currency)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              {data.violations.chargeMismatches.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold">Charge total mismatches (totalCharged ≠ amount + tip)</h4>
                  <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border p-3 font-mono text-xs scrollbar-thin">
                    {data.violations.chargeMismatches.map((ref) => (
                      <div key={ref} className="py-0.5">{ref}</div>
                    ))}
                  </div>
                </div>
              )}

              {data.violations.referenceStats && !data.violations.referenceStats.consistent && (
                <p className="text-sm text-destructive">
                  Reference drift: {data.violations.referenceStats.transactions} transactions vs{' '}
                  {data.violations.referenceStats.uniqueReferences} unique references.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- page ----------

export default function AdminFinancialReconciliationPage() {
  const [downloading, setDownloading] = useState<FinancialReportType | null>(null);

  const download = (type: FinancialReportType) => {
    setDownloading(type);
    downloadFinancialCsv(type)
      .then(() => toast.success(`Report ${type} downloaded`))
      .catch((error) => toast.error(error instanceof Error ? error.message : 'Report download failed'))
      .finally(() => setDownloading(null));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Reconciliation</h1>
          <p className="text-sm text-muted-foreground">
            Provider deliveries vs donations, payout settlement evidence and ledger consistency.
          </p>
        </div>
        <Button asChild variant="outline" className="min-h-11 shrink-0">
          <Link to="/admin/financial">Back to financial centre</Link>
        </Button>
      </div>

      <Tabs defaultValue="payments">
        <TabsList aria-label="Reconciliation sections">
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="withdrawals">Withdrawals</TabsTrigger>
          <TabsTrigger value="ledger">Ledger integrity</TabsTrigger>
        </TabsList>
        <TabsContent value="payments">
          <PaymentsTab />
        </TabsContent>
        <TabsContent value="withdrawals">
          <WithdrawalsTab />
        </TabsContent>
        <TabsContent value="ledger">
          <LedgerTab />
        </TabsContent>
      </Tabs>

      {/* CSV reports */}
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">CSV reports</CardTitle>
          <CardDescription>
            Minor-unit exports (amounts in kobo/cents). Every export is recorded in the audit log.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {REPORTS.map((report) => (
              <div key={report.type} className="flex items-center justify-between gap-3 rounded-xl border p-4">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <FileSpreadsheet className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    {report.label}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{report.description}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => download(report.type)}
                  disabled={downloading !== null}
                  className="min-h-11 shrink-0"
                  aria-label={`Download ${report.label} report`}
                >
                  {downloading === report.type ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Download className="h-4 w-4" aria-hidden="true" />
                  )}
                  CSV
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
