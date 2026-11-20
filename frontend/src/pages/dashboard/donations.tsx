import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, HandCoins } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/shared';
import { useMyDonations } from '@/api/hooks';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { donationStatusBadge } from '@/lib/status';

export default function DashboardDonationsPage() {
  const [page, setPage] = useState(1);
  const donationsQuery = useMyDonations(page);

  const items = useMemo(() => donationsQuery.data?.items ?? [], [donationsQuery.data]);
  const total = donationsQuery.data?.total ?? 0;

  const pageSize = useMemo(() => (items.length > 0 ? items.length : 10), [items]);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">My donations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every gift you have made, with receipts and current status.
        </p>
      </div>

      {donationsQuery.isLoading ? (
        <Card>
          <CardContent className="space-y-4 p-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={HandCoins}
          title="No donations yet"
          description="You have not given to any campaign yet. Find a cause you care about and make your first gift."
          action={
            <Button asChild variant="accent">
              <Link to="/campaigns">Browse campaigns</Link>
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-2 md:p-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Tip</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Receipt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((donation) => {
                  const badge = donationStatusBadge(donation.status);
                  return (
                    <TableRow key={donation.publicRef}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDate(donation.createdAt)}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate font-medium">
                        {donation.campaign ? (
                          <Link
                            to={`/campaigns/${donation.campaign.slug}`}
                            className="hover:text-primary hover:underline"
                          >
                            {donation.campaign.title}
                          </Link>
                        ) : (
                          'Donation'
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-semibold">
                        {formatMoney(donation.amount, donation.currency)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-muted-foreground">
                        {Number(donation.tipAmount) > 0 ? formatMoney(donation.tipAmount, donation.currency) : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                        {/* Receipts are issued only once the donation reaches SUCCEEDED. */}
                        {donation.status === 'SUCCEEDED' ? donation.receiptNumber ?? '—' : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {items.length > 0 && total > pageSize && (
        <nav className="flex items-center justify-between" aria-label="Donations pagination">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || donationsQuery.isFetching}
          >
            <ChevronLeft aria-hidden="true" />
            Previous
          </Button>
          <span className="text-sm text-muted-foreground" aria-live="polite">
            Page {page} of {pageCount} · {total} {total === 1 ? 'donation' : 'donations'}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            disabled={page >= pageCount || donationsQuery.isFetching}
          >
            Next
            <ChevronRight aria-hidden="true" />
          </Button>
        </nav>
      )}
    </div>
  );
}
