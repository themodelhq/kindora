import { useState } from 'react';
import { ArrowLeft, ArrowRight, ScrollText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmptyState, StatCard } from '@/components/shared';
import { useImpactSummary, useImpactTransactions } from '@/api/hooks';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/utils';

type TxBadgeVariant = 'default' | 'accent' | 'secondary' | 'success' | 'warning' | 'destructive' | 'muted';

const TX_BADGE: Record<string, TxBadgeVariant> = {
  DONATION: 'success',
  TIP: 'accent',
  WITHDRAWAL: 'muted',
  MATCH: 'default',
  REFUND: 'destructive',
};

function TransactionTypeBadge({ type }: { type: string }) {
  return <Badge variant={TX_BADGE[type] ?? 'muted'}>{type}</Badge>;
}

function StatSkeleton() {
  return (
    <Card>
      <CardContent className="p-5">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="mt-3 h-8 w-32" />
        <Skeleton className="mt-2 h-3 w-20" />
      </CardContent>
    </Card>
  );
}

export default function ImpactPage() {
  const summary = useImpactSummary();
  const [page, setPage] = useState(1);
  const transactions = useImpactTransactions(page);

  const items = transactions.data?.items ?? [];
  const total = transactions.data?.total ?? 0;
  const pageSize = Math.max(items.length, 1);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="pb-4">
      {/* Hero */}
      <section className="bg-gradient-to-b from-secondary/70 to-background" aria-labelledby="impact-hero-heading">
        <div className="container py-12 lg:py-16">
          <div className="grid items-start gap-8 lg:grid-cols-[1fr_360px]">
            <div>
              <h1 id="impact-hero-heading" className="text-3xl font-extrabold tracking-tight sm:text-4xl">
                Every naira, on the record.
              </h1>
              <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
                KINDORA is built on a simple promise: money raised in public should be traceable in public. This page
                shows the live totals and the raw ledger behind them.
              </p>
            </div>
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="flex items-start gap-4 p-5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10" aria-hidden="true">
                  <ScrollText className="h-5 w-5 text-primary" />
                </span>
                <p className="text-sm leading-relaxed text-foreground/90">
                  KINDORA posts every donation, tip, payout and match to a double-entry ledger. Each transaction has
                  balanced debit and credit entries, so totals can always be recomputed and verified.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Stat cards */}
      <section className="container pt-10" aria-label="Platform impact totals">
        {summary.isError ? (
          <EmptyState
            icon={ScrollText}
            title="Impact data unavailable"
            description="We could not load impact totals right now. Please try again shortly."
            action={
              <Button variant="outline" onClick={() => summary.refetch()}>Try again</Button>
            }
          />
        ) : summary.isLoading ? (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => <StatSkeleton key={i} />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="Successful donations"
              value={(summary.data?.ledger?.successfulDonations ?? summary.data?.totalDonations ?? 0).toLocaleString()}
              hint="Confirmed by payment providers"
            />
            <StatCard
              label="Ledger transactions"
              value={(summary.data?.ledger?.ledgerTransactions ?? 0).toLocaleString()}
              hint={`Across ${summary.data?.ledger?.ledgerAccounts ?? 0} ledger accounts`}
              tone="plain"
            />
            <StatCard
              label="Tips collected"
              value={formatMoney(summary.data?.totalTipsMinor ?? '0', 'NGN')}
              hint="Optional tips keep KINDORA running"
              tone="accent"
            />
            <StatCard
              label="Refunds processed"
              value={(summary.data?.totalRefunded ?? 0).toLocaleString()}
              hint="Returned transparently to donors"
              tone="plain"
            />
          </div>
        )}
      </section>

      {/* Recent daily giving */}
      <section className="container pt-12" aria-labelledby="daily-heading">
        <h2 id="daily-heading" className="text-2xl font-extrabold tracking-tight">Recent daily giving</h2>
        <Card className="mt-4">
          <CardContent className="p-2 sm:p-4">
            {summary.isLoading ? (
              <div className="space-y-3 p-2">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : (summary.data?.recentDaily?.length ?? 0) === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">No daily records yet.</p>
            ) : (
              <Table aria-label="Recent daily donation totals">
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Donations</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(summary.data?.recentDaily ?? []).map((d) => (
                    <TableRow key={d.date}>
                      <TableCell className="font-medium">{formatDate(d.date)}</TableCell>
                      <TableCell className="text-right">{d.donationCount.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-semibold text-primary">
                        {formatMoney(d.donationAmount, d.currency || 'NGN')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Ledger transactions */}
      <section className="container py-12" aria-labelledby="ledger-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="ledger-heading" className="text-2xl font-extrabold tracking-tight">Public ledger transactions</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Raw entries as posted — debits and credits always balance.
            </p>
          </div>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {transactions.isLoading ? 'Loading…' : `${total.toLocaleString()} transactions`}
          </p>
        </div>

        {transactions.isError ? (
          <div className="mt-4">
            <EmptyState
              icon={ScrollText}
              title="Ledger unavailable"
              description="We could not load ledger transactions right now. Please try again."
              action={
                <Button variant="outline" onClick={() => transactions.refetch()}>Try again</Button>
              }
            />
          </div>
        ) : !transactions.isLoading && items.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon={ScrollText}
              title="No transactions posted yet"
              description="As soon as donations, tips, payouts or matches occur, they will appear here."
            />
          </div>
        ) : (
          <Card className="mt-4">
            <CardContent className="divide-y p-0">
              {transactions.isLoading
                ? Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="space-y-3 p-5">
                      <Skeleton className="h-5 w-40" />
                      <Skeleton className="h-4 w-64" />
                      <Skeleton className="h-4 w-48" />
                    </div>
                  ))
                : items.map((t) => (
                    <div key={t.id} className="flex flex-col gap-3 p-5">
                      <div className="flex flex-wrap items-center gap-3">
                        <TransactionTypeBadge type={t.type} />
                        <p className="min-w-0 flex-1 truncate text-sm font-semibold">
                          {t.description ?? `${t.type} ${t.reference}`}
                        </p>
                        <span className="text-xs text-muted-foreground">{formatDate(t.postedAt)}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2" aria-label={`Entries for ${t.type} transaction`}>
                        {t.entries.map((e, i) => (
                          <Badge
                            key={`${t.id}-${i}`}
                            variant="outline"
                            className={
                              e.direction === 'CREDIT'
                                ? 'border-emerald-600/30 bg-emerald-50 text-emerald-800'
                                : 'border-destructive/30 bg-red-50 text-red-800'
                            }
                          >
                            {e.direction} {formatMoney(e.amount, e.currency)}
                          </Badge>
                        ))}
                      </div>
                      <p className="font-mono text-[11px] text-muted-foreground">Ref {t.reference}</p>
                    </div>
                  ))}
            </CardContent>
          </Card>
        )}

        {totalPages > 1 && !transactions.isError && items.length > 0 && (
          <nav className="mt-6 flex items-center justify-center gap-3" aria-label="Ledger pagination">
            <Button
              variant="outline"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              aria-label="Previous ledger page"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Previous
            </Button>
            <span className="text-sm font-medium text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              aria-label="Next ledger page"
            >
              Next
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </nav>
        )}
      </section>
    </div>
  );
}
