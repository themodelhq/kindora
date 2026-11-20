import { useState, type ChangeEvent } from 'react';
import { ChevronLeft, ChevronRight, Loader2, RefreshCw, Undo2 } from 'lucide-react';
import { toast } from 'sonner';

import { useAdminRefund, useAdminReconciliation, useAdminTransactions, useRunReconciliation } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/shared';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import type { LedgerTransactionView } from '@/types/api';

const PAGE_SIZE = 20;

function typeVariant(type: string): BadgeProps['variant'] {
  switch (type) {
    case 'DONATION':
      return 'success';
    case 'MATCH':
      return 'accent';
    case 'WITHDRAWAL':
      return 'secondary';
    case 'REFUND':
      return 'destructive';
    case 'TIP':
      return 'warning';
    default:
      return 'muted';
  }
}

export default function AdminTransactionsPage() {
  const [page, setPage] = useState(1);
  const [refundOpen, setRefundOpen] = useState(false);
  const [donationRef, setDonationRef] = useState('');
  const [reason, setReason] = useState('');

  const { data, isLoading, isError, refetch, isFetching } = useAdminTransactions(page);
  const refund = useAdminRefund();
  const reconciliation = useAdminReconciliation();
  const runReconciliation = useRunReconciliation();

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const canPrev = page > 1;
  const canNext = rows.length >= PAGE_SIZE && page * PAGE_SIZE < total;
  const mismatches = reconciliation.data?.mismatches ?? [];

  const submitRefund = () => {
    if (!donationRef.trim()) {
      toast.error('Enter the donation reference');
      return;
    }
    if (!reason.trim()) {
      toast.error('A reason is required for refunds');
      return;
    }
    refund.mutate(
      { donationRef: donationRef.trim(), reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success('Refund issued');
          setRefundOpen(false);
          setDonationRef('');
          setReason('');
        },
        onError: (error) => toast.error(error instanceof Error ? error.message : 'Refund failed'),
      },
    );
  };

  const submitReconciliation = () => {
    toast.success('Reconciliation started');
    runReconciliation.mutate(undefined, {
      onError: (error) => toast.error(error instanceof Error ? error.message : 'Reconciliation failed to start'),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Ledger transactions</h2>
          <p className="text-sm text-muted-foreground">
            {total} posted {total === 1 ? 'entry' : 'entries'} — every debit and credit on the platform.
          </p>
        </div>
        <Button variant="outline" onClick={() => setRefundOpen(true)} className="min-h-11 shrink-0">
          <Undo2 className="h-4 w-4" aria-hidden="true" />
          Refund a donation
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={Undo2}
          title="Could not load transactions"
          description="Something went wrong while fetching the ledger."
          action={<Button onClick={() => void refetch()}>Try again</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Undo2}
          title="No transactions yet"
          description="Posted ledger transactions will appear here."
        />
      ) : (
        <>
          <div className="rounded-2xl border bg-card shadow-soft">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Entries</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((tx: LedgerTransactionView) => (
                  <TableRow key={tx.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(tx.postedAt)}</TableCell>
                    <TableCell className="max-w-[14rem]">
                      <code className="block truncate font-mono text-xs">{tx.reference}</code>
                    </TableCell>
                    <TableCell>
                      <Badge variant={typeVariant(tx.type)}>{tx.type.replace('_', ' ')}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[18rem]">
                      <span className="block truncate text-muted-foreground">{tx.description ?? '—'}</span>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-0.5 font-mono text-xs">
                        {(tx.entries ?? []).map((entry, index) => (
                          <div key={`${tx.id}-${index}`} className="flex items-center gap-2">
                            <span
                              className={`inline-block w-8 rounded px-1 text-center font-semibold ${
                                entry.direction === 'DEBIT'
                                  ? 'bg-destructive/10 text-destructive'
                                  : 'bg-emerald-100 text-emerald-700'
                              }`}
                            >
                              {entry.direction === 'DEBIT' ? 'DR' : 'CR'}
                            </span>
                            <span>{formatMoney(entry.amount, entry.currency)}</span>
                          </div>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Page {page}
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

      {/* Reconciliation */}
      <Card className="rounded-2xl shadow-soft">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-lg">Payment reconciliation</CardTitle>
              <CardDescription>
                Compare local ledger state against provider records.
                {reconciliation.data?.lastRunAt && ` Last run ${formatDate(reconciliation.data.lastRunAt)}.`}
              </CardDescription>
            </div>
            <Button
              onClick={submitReconciliation}
              disabled={runReconciliation.isPending || reconciliation.isLoading}
              className="min-h-11 shrink-0"
            >
              {runReconciliation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
              )}
              Run reconciliation
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {reconciliation.isLoading ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          ) : reconciliation.isError ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Could not load reconciliation status. Run reconciliation to refresh.
            </p>
          ) : mismatches.length === 0 ? (
            <div className="flex items-center gap-3 rounded-xl bg-emerald-50 px-4 py-3 text-emerald-900" role="status">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100">
                <RefreshCw className="h-4 w-4 text-emerald-700" aria-hidden="true" />
              </span>
              <p className="text-sm font-medium">
                Ledger is clean — no mismatches between local records and provider reports.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Local status</TableHead>
                    <TableHead>Provider status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mismatches.map((m) => (
                    <TableRow key={`${m.reference}-${m.provider}`}>
                      <TableCell>
                        <code className="font-mono text-xs">{m.reference}</code>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{m.provider}</TableCell>
                      <TableCell>
                        <Badge variant="warning">{m.localStatus}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="muted">{m.providerStatus}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Refund dialog */}
      <Dialog
        open={refundOpen}
        onOpenChange={(open) => {
          if (!open) {
            setRefundOpen(false);
            setDonationRef('');
            setReason('');
          }
        }}
      >
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Refund a donation</DialogTitle>
            <DialogDescription>
              Refund reverses ledger entries and marks the donation REFUNDED. The donor is notified and the campaign
              total is adjusted. Use with care.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="refund-donation-ref">Donation reference</Label>
              <Input
                id="refund-donation-ref"
                value={donationRef}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setDonationRef(e.target.value)}
                placeholder="e.g. KDO-8H2K4M9A"
                className="min-h-11 font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="refund-reason">Reason</Label>
              <Textarea
                id="refund-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this donation being refunded?"
                className="min-h-[90px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefundOpen(false)} className="min-h-11">
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={refund.isPending}
              onClick={submitRefund}
              className="min-h-11"
            >
              {refund.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Issue refund
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
