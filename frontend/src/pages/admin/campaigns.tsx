import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban, Check, Eye, ExternalLink, FileText, Loader2, MoreHorizontal, Star, StarOff, X,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/http';
import { useAdminCampaignAction, useAdminCampaigns } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/shared';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import type { CampaignStatus, Paginated } from '@/types/api';

type CampaignAction = 'approve' | 'reject' | 'suspend' | 'feature' | 'unfeature';

interface KycDoc {
  id?: string;
  url?: string;
  type?: string;
  kind?: string;
}

interface KycRecord {
  id: string;
  legalName: string;
  level: string;
  status: string;
  docs?: KycDoc[];
}

const TABS = [
  { value: 'PENDING_REVIEW', label: 'Pending review' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'ALL', label: 'All' },
] as const;

function statusVariant(status: string): BadgeProps['variant'] {
  switch (status as CampaignStatus) {
    case 'ACTIVE':
    case 'COMPLETED':
      return 'success';
    case 'PENDING_REVIEW':
      return 'warning';
    case 'SUSPENDED':
    case 'REJECTED':
      return 'destructive';
    case 'PAUSED':
      return 'secondary';
    default:
      return 'muted';
  }
}

function kycVariant(status: string): BadgeProps['variant'] {
  switch (status) {
    case 'APPROVED':
      return 'success';
    case 'PENDING':
      return 'warning';
    case 'REJECTED':
      return 'destructive';
    default:
      return 'muted';
  }
}

const ACTION_TOASTS: Record<CampaignAction, string> = {
  approve: 'Campaign approved and now live',
  reject: 'Campaign rejected',
  suspend: 'Campaign suspended',
  feature: 'Campaign featured on the homepage',
  unfeature: 'Campaign removed from featured',
};

export default function AdminCampaignsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>('PENDING_REVIEW');

  const { data, isLoading, isError, refetch } = useAdminCampaigns(status);
  const action = useAdminCampaignAction();

  const [previewTarget, setPreviewTarget] = useState<{ title: string; slug: string; excerpt?: string | null; status: string; target: string; currency: string; created: string } | null>(null);
  const [rejectTarget, setRejectTarget] = useState<{ id: string; title: string } | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // ----- KYC queue -----
  const kycQuery = useQuery({
    queryKey: ['admin-kyc'],
    queryFn: () => api<Paginated<KycRecord> | KycRecord[]>('GET', '/admin/kyc?status=PENDING'),
  });
  const kycReview = useMutation({
    mutationFn: (input: { id: string; decision: 'APPROVED' | 'REJECTED'; reason?: string }) =>
      api<{ reviewed: boolean }>(`POST`, `/admin/kyc/${input.id}/review`, { decision: input.decision, reason: input.reason }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-kyc'] });
      void qc.invalidateQueries({ queryKey: ['admin-stats'] });
    },
  });

  const [kycRejectTarget, setKycRejectTarget] = useState<KycRecord | null>(null);
  const [kycReason, setKycReason] = useState('');

  const kycRows = useMemo<KycRecord[]>(() => {
    const raw = kycQuery.data;
    if (Array.isArray(raw)) return raw;
    return raw?.items ?? [];
  }, [kycQuery.data]);

  const rows = data?.items ?? [];

  const runAction = (id: string, act: CampaignAction, note?: string) => {
    // Optimistic feedback: toast immediately, roll back with an error toast on failure.
    toast.success(ACTION_TOASTS[act]);
    action.mutate(
      { id, action: act, note },
      {
        onError: (error) => toast.error(error instanceof Error ? error.message : 'Action failed — refresh to confirm'),
      },
    );
  };

  const submitReject = () => {
    if (!rejectTarget) return;
    if (!rejectReason.trim()) {
      toast.error('A rejection reason is required');
      return;
    }
    runAction(rejectTarget.id, 'reject', rejectReason.trim());
    setRejectTarget(null);
    setRejectReason('');
  };

  const reviewKyc = (record: KycRecord, decision: 'APPROVED' | 'REJECTED', reason?: string) => {
    toast.success(decision === 'APPROVED' ? `KYC approved for ${record.legalName}` : `KYC rejected for ${record.legalName}`);
    kycReview.mutate(
      { id: record.id, decision, reason },
      {
        onError: (error) => toast.error(error instanceof Error ? error.message : 'KYC review failed — refresh to confirm'),
      },
    );
    setKycRejectTarget(null);
    setKycReason('');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Campaign review</h2>
          <p className="text-sm text-muted-foreground">
            Approve, reject, suspend or feature fundraisers before they go live.
          </p>
        </div>
        <Tabs value={status} onValueChange={setStatus}>
          <TabsList aria-label="Filter campaigns by status">
            {TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {isLoading ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={FileText}
          title="Could not load campaigns"
          description="Something went wrong while fetching the review queue."
          action={<Button onClick={() => void refetch()}>Try again</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="Nothing here"
          description={`No campaigns with status ${status === 'ALL' ? 'at all' : status.replace('_', ' ').toLowerCase()}.`}
        />
      ) : (
        <div className="rounded-2xl border bg-card shadow-soft">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Organizer</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="max-w-[16rem]">
                    <Link to={`/campaigns/${row.slug}`} className="font-medium text-primary hover:underline">
                      {row.title}
                    </Link>
                    {row.isFeatured && (
                      <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-amber-600">
                        <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden="true" />
                        Featured
                      </span>
                    )}
                    {row.excerpt && (
                      <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{row.excerpt}</p>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[12rem] truncate">
                    {row.createdBy
                      ? `${row.createdBy.firstName} ${row.createdBy.lastName}`
                      : row.organization?.name ?? '—'}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatMoney(row.targetAmount, row.currency)}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(row.createdAt)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(row.status)}>{row.status.replace('_', ' ')}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11"
                        aria-label={`Preview ${row.title}`}
                        onClick={() =>
                          setPreviewTarget({
                            title: row.title,
                            slug: row.slug,
                            excerpt: row.excerpt,
                            status: row.status,
                            target: formatMoney(row.targetAmount, row.currency),
                            currency: row.currency,
                            created: formatDate(row.createdAt),
                          })
                        }
                      >
                        <Eye className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="min-h-11 min-w-11" aria-label={`Actions for ${row.title}`}>
                            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          {row.status === 'PENDING_REVIEW' && (
                            <>
                              <DropdownMenuItem onSelect={() => runAction(row.id, 'approve')}>
                                <Check className="text-emerald-600" aria-hidden="true" />
                                Approve
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onSelect={() => {
                                  setRejectReason('');
                                  setRejectTarget({ id: row.id, title: row.title });
                                }}
                              >
                                <X aria-hidden="true" />
                                Reject…
                              </DropdownMenuItem>
                            </>
                          )}
                          {row.status === 'ACTIVE' && (
                            <>
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onSelect={() => runAction(row.id, 'suspend')}
                              >
                                <Ban aria-hidden="true" />
                                Suspend
                              </DropdownMenuItem>
                              {row.isFeatured ? (
                                <DropdownMenuItem onSelect={() => runAction(row.id, 'unfeature')}>
                                  <StarOff aria-hidden="true" />
                                  Unfeature
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem onSelect={() => runAction(row.id, 'feature')}>
                                  <Star aria-hidden="true" />
                                  Feature
                                </DropdownMenuItem>
                              )}
                            </>
                          )}
                          {row.status !== 'PENDING_REVIEW' && row.status !== 'ACTIVE' && (
                            <DropdownMenuItem disabled>No actions available</DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Preview dialog */}
      <Dialog open={previewTarget !== null} onOpenChange={(open) => !open && setPreviewTarget(null)}>
        <DialogContent className="max-w-lg rounded-2xl">
          <DialogHeader>
            <DialogTitle>{previewTarget?.title}</DialogTitle>
            <DialogDescription>Quick preview before you approve or reject.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              {previewTarget && <Badge variant={statusVariant(previewTarget.status)}>{previewTarget.status.replace('_', ' ')}</Badge>}
              {previewTarget && <Badge variant="muted">Target {previewTarget.target}</Badge>}
              {previewTarget && <Badge variant="muted">Created {previewTarget.created}</Badge>}
            </div>
            <div className="rounded-xl border bg-muted/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Excerpt</p>
              <p className="mt-2 text-foreground/90">
                {previewTarget?.excerpt?.trim()
                  ? previewTarget.excerpt
                  : 'No excerpt was provided for this campaign. Open the campaign page for the full story.'}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewTarget(null)} className="min-h-11">
              Close
            </Button>
            {previewTarget && (
              <Button asChild className="min-h-11">
                <Link to={`/campaigns/${previewTarget.slug}`}>Open campaign page</Link>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={rejectTarget !== null} onOpenChange={(open) => {
        if (!open) {
          setRejectTarget(null);
          setRejectReason('');
        }
      }}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Reject campaign</DialogTitle>
            <DialogDescription>
              {rejectTarget?.title} — add a short reason. It is shown to the organizer so they can fix and resubmit.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason for rejection (required)"
            className="min-h-[100px]"
            aria-label="Rejection reason"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRejectTarget(null);
                setRejectReason('');
              }}
              className="min-h-11"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!rejectReason.trim() || action.isPending}
              onClick={submitReject}
              className="min-h-11"
            >
              {action.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Reject campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* KYC queue */}
      <section aria-label="KYC verification queue" className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Organization verification (KYC)</h2>
          <p className="text-sm text-muted-foreground">
            Pending organization submissions. Approve to grant the verified badge.
          </p>
        </div>
        {kycQuery.isLoading ? (
          <div className="space-y-3" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : kycQuery.isError ? (
          <EmptyState
            icon={FileText}
            title="Could not load KYC queue"
            description="Something went wrong while fetching verification submissions."
            action={<Button onClick={() => void kycQuery.refetch()}>Try again</Button>}
          />
        ) : kycRows.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No pending KYC submissions"
            description="Organization verification documents will appear here for review."
          />
        ) : (
          <div className="rounded-2xl border bg-card shadow-soft">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Legal name</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Documents</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {kycRows.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell className="font-medium">{record.legalName}</TableCell>
                    <TableCell className="text-muted-foreground">{record.level}</TableCell>
                    <TableCell>
                      <Badge variant={kycVariant(record.status)}>{record.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {record.docs && record.docs.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {record.docs.map((doc, index) =>
                            doc.url ? (
                              <a
                                key={doc.id ?? index}
                                href={doc.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                                aria-label={`Open document ${index + 1} for ${record.legalName} (opens in a new tab)`}
                              >
                                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                                {doc.type ?? doc.kind ?? `Doc ${index + 1}`}
                              </a>
                            ) : null,
                          )}
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">No documents attached</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          className="min-h-11"
                          disabled={kycReview.isPending}
                          onClick={() => reviewKyc(record, 'APPROVED')}
                        >
                          <Check className="h-4 w-4" aria-hidden="true" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-11"
                          onClick={() => {
                            setKycReason('');
                            setKycRejectTarget(record);
                          }}
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                          Reject
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* KYC reject dialog */}
      <Dialog open={kycRejectTarget !== null} onOpenChange={(open) => {
        if (!open) {
          setKycRejectTarget(null);
          setKycReason('');
        }
      }}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Reject KYC submission</DialogTitle>
            <DialogDescription>
              {kycRejectTarget?.legalName} — explain what is missing or invalid so the organization can resubmit.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={kycReason}
            onChange={(e) => setKycReason(e.target.value)}
            placeholder="Reason for rejection (required)"
            className="min-h-[100px]"
            aria-label="KYC rejection reason"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setKycRejectTarget(null);
                setKycReason('');
              }}
              className="min-h-11"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!kycReason.trim() || kycReview.isPending}
              onClick={() => kycRejectTarget && reviewKyc(kycRejectTarget, 'REJECTED', kycReason.trim())}
              className="min-h-11"
            >
              {kycReview.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Reject submission
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
