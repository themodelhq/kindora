import { useState } from 'react';
import { Flag, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { useAdminDismissFraud, useAdminFraudSignals, useAdminModeration, useAdminResolveModeration } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/shared';
import { formatDate } from '@/lib/utils';

interface ModerationCase {
  id: string;
  entityType: string;
  entityId: string;
  reason: string;
  status: string;
  description?: string;
  createdAt: string;
}

interface FraudSignal {
  id: string;
  rule: string;
  severity: string;
  status: string;
  createdAt: string;
  campaign?: { title: string; slug: string };
}

function reasonVariant(reason: string): BadgeProps['variant'] {
  switch (reason.toUpperCase()) {
    case 'FRAUD':
      return 'destructive';
    case 'MISLEADING':
      return 'warning';
    case 'SPAM':
      return 'accent';
    case 'OTHER':
      return 'muted';
    default:
      return 'secondary';
  }
}

function caseStatusVariant(status: string): BadgeProps['variant'] {
  switch (status) {
    case 'OPEN':
      return 'warning';
    case 'RESOLVED':
      return 'success';
    case 'DISMISSED':
      return 'muted';
    default:
      return 'muted';
  }
}

function severityVariant(severity: string): BadgeProps['variant'] {
  switch (severity.toUpperCase()) {
    case 'HIGH':
      return 'destructive';
    case 'MEDIUM':
      return 'warning';
    case 'LOW':
      return 'secondary';
    default:
      return 'muted';
  }
}

export default function AdminModerationPage() {
  const moderation = useAdminModeration();
  const fraud = useAdminFraudSignals();
  const resolve = useAdminResolveModeration();
  const dismissFraud = useAdminDismissFraud();

  const [resolveTarget, setResolveTarget] = useState<ModerationCase | null>(null);
  const [resolveNote, setResolveNote] = useState('');

  const cases = moderation.data?.items ?? [];
  const signals = fraud.data?.items ?? [];

  const submitResolve = (act: 'action' | 'clear') => {
    if (!resolveTarget) return;
    if (!resolveNote.trim()) {
      toast.error('A note is required to resolve a case');
      return;
    }
    toast.success(
      act === 'action'
        ? 'Case resolved with action'
        : 'Case cleared',
    );
    resolve.mutate(
      { id: resolveTarget.id, action: act, note: resolveNote.trim() },
      {
        onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not resolve the case'),
      },
    );
    setResolveTarget(null);
    setResolveNote('');
  };

  const dismissSignal = (signal: FraudSignal) => {
    toast.success(`Fraud signal ${signal.rule} dismissed`);
    dismissFraud.mutate(signal.id, {
      onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not dismiss the signal'),
    });
  };

  return (
    <div className="space-y-8">
      {/* Moderation cases */}
      <section aria-label="Moderation cases" className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Moderation cases</h2>
          <p className="text-sm text-muted-foreground">
            Reports from the community. Resolve with an action or clear them if unfounded.
          </p>
        </div>
        {moderation.isLoading ? (
          <div className="space-y-3" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : moderation.isError ? (
          <EmptyState
            icon={Flag}
            title="Could not load cases"
            description="Something went wrong while fetching moderation cases."
            action={<Button onClick={() => void moderation.refetch()}>Try again</Button>}
          />
        ) : cases.length === 0 ? (
          <EmptyState
            icon={Flag}
            title="No moderation cases"
            description="Reported content will appear here for review."
          />
        ) : (
          <div className="rounded-2xl border bg-card shadow-soft">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Entity</TableHead>
                  <TableHead>Entity ID</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Reported</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cases.map((c: ModerationCase) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.entityType}</TableCell>
                    <TableCell>
                      <code className="font-mono text-xs">{c.entityId}</code>
                    </TableCell>
                    <TableCell>
                      <Badge variant={reasonVariant(c.reason)}>{c.reason}</Badge>
                      {c.description && (
                        <p className="mt-1 max-w-[16rem] truncate text-xs text-muted-foreground">{c.description}</p>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(c.createdAt)}</TableCell>
                    <TableCell>
                      <Badge variant={caseStatusVariant(c.status)}>{c.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {c.status === 'OPEN' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-11"
                          onClick={() => {
                            setResolveNote('');
                            setResolveTarget(c);
                          }}
                        >
                          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                          Resolve
                        </Button>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* Fraud signals */}
      <section aria-label="Fraud signals" className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Fraud signals</h2>
          <p className="text-sm text-muted-foreground">
            Raised automatically by detection rules. Dismiss signals that turn out to be false positives.
          </p>
        </div>
        {fraud.isLoading ? (
          <div className="space-y-3" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : fraud.isError ? (
          <EmptyState
            icon={ShieldAlert}
            title="Could not load fraud signals"
            description="Something went wrong while fetching fraud signals."
            action={<Button onClick={() => void fraud.refetch()}>Try again</Button>}
          />
        ) : signals.length === 0 ? (
          <EmptyState
            icon={ShieldAlert}
            title="No fraud signals"
            description="Signals raised by detection rules will appear here."
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {signals.map((s: FraudSignal) => (
              <Card key={s.id} className="rounded-2xl shadow-soft">
                <CardContent className="space-y-3 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={severityVariant(s.severity)}>{s.severity}</Badge>
                      <span className="font-semibold">{s.rule}</span>
                    </div>
                    <Badge variant={s.status === 'OPEN' ? 'warning' : 'muted'}>{s.status}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Campaign:{' '}
                    {s.campaign ? (
                      <span className="font-medium text-foreground">{s.campaign.title}</span>
                    ) : (
                      '—'
                    )}
                  </p>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-muted-foreground">{formatDate(s.createdAt)}</span>
                    {s.status === 'OPEN' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-11"
                        disabled={dismissFraud.isPending}
                        onClick={() => dismissSignal(s)}
                      >
                        {dismissFraud.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                        Dismiss
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Resolve dialog */}
      <Dialog
        open={resolveTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setResolveTarget(null);
            setResolveNote('');
          }
        }}
      >
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Resolve case</DialogTitle>
            <DialogDescription>
              {resolveTarget
                ? `${resolveTarget.entityType} ${resolveTarget.entityId} — reported for ${resolveTarget.reason}. Add a note describing your decision.`
                : 'Add a note describing your decision.'}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={resolveNote}
            onChange={(e) => setResolveNote(e.target.value)}
            placeholder="Resolution note (required)"
            className="min-h-[100px]"
            aria-label="Resolution note"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setResolveTarget(null);
                setResolveNote('');
              }}
              className="min-h-11"
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              disabled={!resolveNote.trim() || resolve.isPending}
              onClick={() => submitResolve('clear')}
              className="min-h-11"
            >
              Clear report
            </Button>
            <Button
              disabled={!resolveNote.trim() || resolve.isPending}
              onClick={() => submitResolve('action')}
              className="min-h-11"
            >
              {resolve.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Take action
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
