import { Fragment, useCallback, useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck, Ban, Banknote, ChevronDown, ChevronRight, ClipboardList, FileSearch, Loader2,
  MessageSquareWarning, RefreshCcw, RotateCcw, ShieldAlert, ShieldCheck, Wallet, X,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  useAdminWithdrawals, useMyFiles, useReconcileWithdrawal, useRegisterUpload, useRequireInfo,
  useSecondApproval, useSettlePayout, useUnderReview, useVerifyPayoutAttempt,
  useWithdrawalApprove, useWithdrawalReject, useWithdrawalRetry, type MfaPurpose,
} from '@/api/hooks';
import { ApiError } from '@/lib/http';
import { UPLOAD_ACCEPT, storedFileStatusView, uploadWithPresignedPost } from '@/lib/storage';
import { MfaChallengeDialog, type MfaChallengeScope } from '@/components/mfa/mfa-challenge-dialog';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/shared';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { PAYOUT_PROVIDERS, PAYOUT_PROVIDER_LABELS, validateSettleInput, type SettleFormErrors } from '@/lib/withdrawal-form';
import { payoutAttemptStatusBadge, settlementBlockedExplanation } from '@/lib/status';
import type { PayoutAttempt, Withdrawal } from '@/types/api';

/**
 * `Closed` groups the terminal statuses (backend accepts comma-separated
 * values on GET /withdrawals/admin/all?status=).
 */
const TABS = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'UNDER_REVIEW', label: 'Under review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'PROCESSING', label: 'Processing' },
  { value: 'REQUIRES_RECONCILIATION', label: 'Needs reconciliation' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'PAID', label: 'Paid' },
  { value: 'REJECTED,CANCELLED,REVERSED,REQUIRES_INFORMATION', label: 'Closed' },
] as const;

const MIN_NOTE_LENGTH = 3;

type NoteAction = 'reject' | 'require-info' | 'second-approval';

const NOTE_ACTIONS: Record<NoteAction, {
  title: string;
  cta: string;
  destructive: boolean;
  mfaTitle: string;
  operation: string;
  purpose: MfaPurpose;
}> = {
  reject: {
    title: 'Reject payout',
    cta: 'Reject payout',
    destructive: true,
    mfaTitle: 'Authorize rejection — MFA',
    operation: 'Reject',
    purpose: 'PAYOUT_STATE_CHANGE',
  },
  'require-info': {
    title: 'Request more information',
    cta: 'Request info',
    destructive: false,
    mfaTitle: 'Authorize information request — MFA',
    operation: 'Request information for',
    purpose: 'PAYOUT_STATE_CHANGE',
  },
  'second-approval': {
    title: 'Record second approval',
    cta: 'Confirm second approval',
    destructive: false,
    mfaTitle: 'Authorize second approval — MFA',
    operation: 'Second-approve',
    purpose: 'PAYOUT_SECOND_APPROVAL',
  },
};

const EVIDENCE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

function statusVariant(status: Withdrawal['status']): BadgeProps['variant'] {
  switch (status) {
    case 'PAID':
      return 'success';
    case 'PENDING':
    case 'UNDER_REVIEW':
    case 'REQUIRES_INFORMATION':
    case 'REQUIRES_RECONCILIATION':
      return 'warning';
    case 'APPROVED':
    case 'PROCESSING':
      return 'secondary';
    case 'REJECTED':
    case 'FAILED':
      return 'destructive';
    case 'CANCELLED':
    case 'REVERSED':
      return 'muted';
    default:
      return 'muted';
  }
}

function destinationSummary(destination: Withdrawal['destination']): string {
  if (!destination || typeof destination !== 'object') return '—';
  const str = (key: string): string | undefined => {
    const value = destination[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  // Masked values (****last4) are shown as-is — never re-truncate them.
  const masked = (value: string): string => (value.includes('*') ? value : `••${value.slice(-4)}`);
  const bank = str('bankName') ?? str('bankCode');
  const account = str('accountNumber');
  if (bank && account) return `${bank} ${masked(account)}`;
  const phone = str('phoneNumber') ?? str('phone');
  if (phone) return `Mobile money ${masked(phone)}`;
  const firstTwo = Object.values(destination)
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .slice(0, 2);
  return firstTwo.length > 0 ? firstTwo.join(' · ') : '—';
}

/** Backend note DTOs require at least 3 characters for every review action. */
function noteError(note: string): string | null {
  if (!note.trim()) return 'A short note is required for this action.';
  if (note.trim().length < MIN_NOTE_LENGTH) return `The note must be at least ${MIN_NOTE_LENGTH} characters.`;
  return null;
}

function toFriendlyError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 403 from a payout mutation means the fresh-MFA authorization is missing/expired. */
function isMfaMissingError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** §7.4 — every MFA prompt names the payout and the amount being authorized. */
function MfaOperationDescription({ withdrawal, operation }: { withdrawal: Withdrawal; operation: string }) {
  return (
    <span>
      You are authorizing: <strong>{operation}</strong> payout{' '}
      <code className="font-mono text-xs">{withdrawal.publicRef}</code> for{' '}
      <strong>{formatMoney(withdrawal.amount, withdrawal.currency)}</strong>
      {withdrawal.campaign?.title ? ` — campaign "${withdrawal.campaign.title}"` : ''}. Check the reference and
      amount carefully before confirming.
    </span>
  );
}

function PayoutAttemptList({ attempts }: { attempts: PayoutAttempt[] }) {
  if (attempts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No provider payout attempt has been recorded for this withdrawal yet. Attempt verification becomes
        available once the transfer has been initiated with the provider.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Provider payout attempts (latest first)
      </p>
      {attempts.map((attempt) => {
        const badge = payoutAttemptStatusBadge(attempt.status);
        const explanation = settlementBlockedExplanation(attempt);
        return (
          <div key={attempt.id} className="rounded-xl border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Attempt {attempt.attemptNo}</Badge>
              <Badge variant={badge.variant}>{badge.label}</Badge>
              <span className="text-sm font-medium">{attempt.provider ?? 'Provider unknown'}</span>
            </div>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              <div className="flex gap-1">
                <dt className="text-muted-foreground">Classification:</dt>
                <dd className="font-medium">{attempt.classification ?? '—'}</dd>
              </div>
              <div className="flex gap-1">
                <dt className="text-muted-foreground">Provider status:</dt>
                <dd className="font-medium">{attempt.providerStatus ?? '—'}</dd>
              </div>
              <div className="flex gap-1">
                <dt className="text-muted-foreground">Last verified:</dt>
                <dd className="font-medium">
                  {attempt.lastVerifiedAt ? formatDate(attempt.lastVerifiedAt) : 'never verified'}
                </dd>
              </div>
              <div className="flex gap-1">
                <dt className="text-muted-foreground">Failure reason:</dt>
                <dd className="font-medium">{attempt.failureReason ?? '—'}</dd>
              </div>
            </dl>
            {explanation && (
              <p role="note" className="mt-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {explanation}
              </p>
            )}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Stripe payouts are unavailable in v1.0.7 (donations remain supported). Payout transfers run through
        Paystack or Flutterwave with independent amount, currency and beneficiary verification before any
        withdrawal can be marked paid.
      </p>
    </div>
  );
}

interface EvidenceFilePickerProps {
  idPrefix: string;
  /** Registered StoredFile id currently attached (null = none). */
  fileId: string | null;
  onFileIdChange: (fileId: string | null) => void;
  /** Reports whether the attached file has finished scanning as CLEAN + APPROVED. */
  onReadinessChange: (ready: boolean) => void;
  optional?: boolean;
}

/**
 * Registered-evidence file picker (v1.0.4 storage contract). Uploads through
 * the canonical pipeline: POST /storage/uploads (presigned POST policy) ->
 * POST FormData to postUrl (policy fields first, then the file) ->
 * POST /storage/confirm {key} -> poll GET /storage/mine for the scan verdict.
 * Submission is unlocked only once the file is APPROVED with a CLEAN verdict.
 */
function EvidenceFilePicker({ idPrefix, fileId, onFileIdChange, onReadinessChange, optional = false }: EvidenceFilePickerProps) {
  const queryClient = useQueryClient();
  const registerUpload = useRegisterUpload();
  const filesQuery = useMyFiles(1);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  const tracked = useMemo(
    () => filesQuery.data?.items.find((file) => file.id === fileId) ?? null,
    [filesQuery.data, fileId],
  );
  const scanReady = tracked?.status === 'APPROVED' && tracked?.scanVerdict === 'CLEAN';
  const scanBlocked = tracked?.status === 'REJECTED' || tracked?.status === 'FAILED';

  useEffect(() => {
    onReadinessChange(scanReady);
  }, [scanReady, onReadinessChange]);

  async function handleFileSelected(file: File) {
    setError(null);
    if (!EVIDENCE_CONTENT_TYPES.includes(file.type)) {
      setError('The receipt must be a PDF, JPEG, PNG or WebP file.');
      return;
    }
    setUploading(true);
    try {
      const registration = await registerUpload.mutateAsync({
        fileName: file.name,
        contentType: file.type,
        kind: 'payout-evidence',
      });
      const confirmed = await uploadWithPresignedPost(registration, file);
      onFileIdChange(confirmed.fileId);
      void queryClient.invalidateQueries({ queryKey: ['storage'] });
    } catch (err) {
      setError(toFriendlyError(err, 'Could not upload the evidence file. Please try again.'));
    } finally {
      setUploading(false);
      setFileInputKey((key) => key + 1);
    }
  }

  const statusView = tracked ? storedFileStatusView(tracked) : null;

  return (
    <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
      {fileId && tracked && statusView ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{tracked.fileName}</p>
            <div className="mt-1 flex items-center gap-2">
              <Badge variant={statusView.variant}>{statusView.label}</Badge>
              {scanReady && <span className="text-xs text-muted-foreground">Ready to attach</span>}
            </div>
          </div>
          {!uploading && (
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-9 w-9 shrink-0"
              onClick={() => {
                setError(null);
                onFileIdChange(null);
              }}
              aria-label="Remove the selected evidence file"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      ) : fileId && !tracked ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Checking the file registry…
        </p>
      ) : (
        <>
          <Label htmlFor={`${idPrefix}-evidence`}>{optional ? 'Evidence file (optional)' : 'Evidence file'}</Label>
          <Input
            id={`${idPrefix}-evidence`}
            key={fileInputKey}
            type="file"
            accept={UPLOAD_ACCEPT.document}
            disabled={uploading}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const file = e.target.files?.[0];
              if (file) void handleFileSelected(file);
            }}
            className="min-h-11 file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-semibold file:text-primary-foreground"
            aria-describedby={`${idPrefix}-evidence-hint`}
          />
          <p id={`${idPrefix}-evidence-hint`} className="text-xs text-muted-foreground">
            {optional
              ? 'Attach the provider receipt or bank statement (PDF or image) if you have it.'
              : 'Upload the transfer receipt (PDF, JPEG, PNG or WebP). It is scanned before it can be attached.'}
          </p>
        </>
      )}
      {uploading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Uploading and registering the file…
        </p>
      )}
      {fileId && tracked && !scanReady && !scanBlocked && !uploading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Waiting for the malware scan verdict…
        </p>
      )}
      {fileId && scanBlocked && (
        <p role="alert" className="text-xs font-medium text-destructive">
          The file was blocked by the malware scan or rejected. Remove it and upload a different receipt.
        </p>
      )}
      {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
}

interface PendingMfaAction {
  purpose: MfaPurpose;
  scopeId: string;
  title: string;
  description: ReactNode;
  run: (challenge: string) => void;
}

export default function AdminWithdrawalsPage() {
  const [status, setStatus] = useState<string>('PENDING');

  const { data, isLoading, isError, refetch } = useAdminWithdrawals(status);
  const underReview = useUnderReview();
  const requireInfo = useRequireInfo();
  const approve = useWithdrawalApprove();
  const secondApproval = useSecondApproval();
  const reject = useWithdrawalReject();
  const settle = useSettlePayout();
  const retry = useWithdrawalRetry();
  const verifyAttempt = useVerifyPayoutAttempt();
  const reconcile = useReconcileWithdrawal();

  // Fresh-MFA gate: exactly ONE dialog open at a time; the pending action and
  // its continuation are stored here (v1.0.4 §7 — challenge bound to purpose + scope).
  const [mfaAction, setMfaAction] = useState<PendingMfaAction | null>(null);

  const [noteTarget, setNoteTarget] = useState<{ kind: NoteAction; withdrawal: Withdrawal } | null>(null);
  const [note, setNote] = useState('');

  const [reconcileTarget, setReconcileTarget] = useState<Withdrawal | null>(null);
  const [reconcileNote, setReconcileNote] = useState('');
  const [reconcileEvidenceId, setReconcileEvidenceId] = useState<string | null>(null);
  const [reconcileEvidenceReady, setReconcileEvidenceReady] = useState(false);

  const [settleTarget, setSettleTarget] = useState<{ withdrawal: Withdrawal; challenge: string } | null>(null);
  const [settleForm, setSettleForm] = useState({ payoutProvider: '', providerTransferRef: '', payoutProviderTxnId: '', evidenceFileId: '' });
  const [settleErrors, setSettleErrors] = useState<SettleFormErrors>({});
  const [settleServerError, setSettleServerError] = useState<string | null>(null);
  const [settleEvidenceReady, setSettleEvidenceReady] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);

  const rows = data?.items ?? [];
  const activeTabLabel = TABS.find((tab) => tab.value === status)?.label ?? status;

  const handleMutationError = useCallback(
    (error: unknown, fallback: string, reopenMfa?: PendingMfaAction) => {
      toast.error(toFriendlyError(error, fallback));
      // Missing/expired fresh-MFA authorization: reopen the gate instead of dead-ending.
      if (reopenMfa && isMfaMissingError(error)) setMfaAction(reopenMfa);
    },
    [],
  );

  const setSettleEvidenceReadySafe = useCallback((ready: boolean) => setSettleEvidenceReady(ready), []);
  const setReconcileEvidenceReadySafe = useCallback((ready: boolean) => setReconcileEvidenceReady(ready), []);

  const openUnderReviewMfa = (w: Withdrawal) => {
    const action: PendingMfaAction = {
      purpose: 'PAYOUT_STATE_CHANGE',
      scopeId: w.id,
      title: 'Authorize review start — MFA',
      description: <MfaOperationDescription withdrawal={w} operation="Move to under review" />,
      run: (challenge) => {
        underReview.mutate(
          { id: w.id, challenge },
          {
            onSuccess: () => toast.success(`Payout ${w.publicRef} moved to under review`),
            onError: (error) => handleMutationError(error, 'Could not start the review — refresh to confirm', action),
          },
        );
      },
    };
    setMfaAction(action);
  };

  const openApproveMfa = (w: Withdrawal) => {
    const action: PendingMfaAction = {
      purpose: 'PAYOUT_FIRST_APPROVAL',
      scopeId: w.id,
      title: 'Authorize first approval — MFA',
      description: <MfaOperationDescription withdrawal={w} operation="Approve" />,
      run: (challenge) => {
        approve.mutate(
          { id: w.id, challenge },
          {
            onSuccess: () =>
              toast.success(`Payout ${w.publicRef} approved — a second administrator must confirm before settlement`),
            onError: (error) => handleMutationError(error, 'Approval failed — refresh to confirm', action),
          },
        );
      },
    };
    setMfaAction(action);
  };

  const openNoteDialog = (kind: NoteAction, w: Withdrawal) => {
    setNote('');
    setNoteTarget({ kind, withdrawal: w });
  };

  /** Note FIRST, then the fresh-MFA gate, then the mutation with both. */
  const submitNoteAction = () => {
    if (!noteTarget) return;
    const invalid = noteError(note);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    const { kind, withdrawal } = noteTarget;
    const trimmed = note.trim();
    const config = NOTE_ACTIONS[kind];
    const action: PendingMfaAction = {
      purpose: config.purpose,
      scopeId: withdrawal.id,
      title: config.mfaTitle,
      description: <MfaOperationDescription withdrawal={withdrawal} operation={config.operation} />,
      run: (challenge) => {
        if (kind === 'reject') {
          reject.mutate(
            { id: withdrawal.id, note: trimmed, challenge },
            {
              onSuccess: () => toast.success(`Payout ${withdrawal.publicRef} rejected`),
              onError: (error) => handleMutationError(error, 'Rejection failed — refresh to confirm', action),
            },
          );
        } else if (kind === 'require-info') {
          requireInfo.mutate(
            { id: withdrawal.id, note: trimmed, challenge },
            {
              onSuccess: () => toast.success(`More information requested for ${withdrawal.publicRef}`),
              onError: (error) => handleMutationError(error, 'Could not request information — refresh to confirm', action),
            },
          );
        } else {
          secondApproval.mutate(
            { id: withdrawal.id, note: trimmed, challenge },
            {
              onSuccess: () => toast.success(`Second approval recorded for ${withdrawal.publicRef}`),
              onError: (error) => handleMutationError(error, 'Could not record the second approval — refresh to confirm', action),
            },
          );
        }
      },
    };
    setNoteTarget(null);
    setNote('');
    setMfaAction(action);
  };

  /** Settlement authorizes BEFORE the form opens (§10): MFA first, then the form. */
  const openSettleMfa = (w: Withdrawal) => {
    const action: PendingMfaAction = {
      purpose: 'PAYOUT_SETTLEMENT',
      scopeId: w.id,
      title: 'Authorize settlement — MFA',
      description: <MfaOperationDescription withdrawal={w} operation="Settle" />,
      run: (challenge) => {
        setSettleForm({
          payoutProvider: w.payoutProvider ?? '',
          providerTransferRef: w.providerTransferRef ?? '',
          payoutProviderTxnId: w.payoutProviderTxnId ?? '',
          evidenceFileId: '',
        });
        setSettleErrors({});
        setSettleServerError(null);
        setSettleEvidenceReady(false);
        setSettleTarget({ withdrawal: w, challenge });
      },
    };
    setMfaAction(action);
  };

  const submitSettle = () => {
    if (!settleTarget) return;
    const withdrawal = settleTarget.withdrawal;
    const input = {
      payoutProvider: settleForm.payoutProvider,
      providerTransferRef: settleForm.providerTransferRef.trim(),
      payoutProviderTxnId: settleForm.payoutProviderTxnId.trim() || undefined,
      evidenceFileId: settleForm.evidenceFileId,
    };
    const errors = validateSettleInput(input);
    setSettleErrors(errors);
    setSettleServerError(null);
    if (Object.keys(errors).length > 0) {
      toast.error('Fix the highlighted fields before recording the settlement.');
      return;
    }
    settle.mutate(
      { id: withdrawal.id, ...input, challenge: settleTarget.challenge },
      {
        onSuccess: () => {
          toast.success(`Payout ${withdrawal.publicRef} settled — ledger posted`);
          setSettleTarget(null);
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) {
            const message = `Payout ${withdrawal.publicRef} has already been settled. The ledger posted exactly once — refresh the list to see the current state.`;
            setSettleServerError(message);
            toast.error(message);
            return;
          }
          if (isMfaMissingError(error)) {
            toast.error('Fresh MFA authorization is required — authorize again to continue.');
            setSettleTarget(null);
            openSettleMfa(withdrawal);
            return;
          }
          const fallback = 'Settlement failed — refresh to confirm the payout state before retrying.';
          setSettleServerError(toFriendlyError(error, fallback));
          toast.error(toFriendlyError(error, fallback));
        },
      },
    );
  };

  const openVerifyMfa = (w: Withdrawal) => {
    const attempt = w.payoutAttempts?.[0];
    if (!attempt) return;
    const action: PendingMfaAction = {
      purpose: 'PAYOUT_RECONCILIATION',
      scopeId: w.id,
      title: 'Authorize attempt verification — MFA',
      description: <MfaOperationDescription withdrawal={w} operation="Verify the provider payout attempt for" />,
      run: (challenge) => {
        verifyAttempt.mutate(
          { attemptId: attempt.id, challenge },
          {
            onSuccess: (res) =>
              toast.success(
                `Provider attempt for ${w.publicRef} verified — status ${res.attempt?.status ?? 'updated'}${res.applied ? '' : ' (no state change applied)'}`,
              ),
            onError: (error) => handleMutationError(error, 'Verification failed — refresh to confirm', action),
          },
        );
      },
    };
    setMfaAction(action);
  };

  const openReconcileDialog = (w: Withdrawal) => {
    setReconcileNote('');
    setReconcileEvidenceId(null);
    setReconcileEvidenceReady(false);
    setReconcileTarget(w);
  };

  const submitReconcile = () => {
    if (!reconcileTarget) return;
    const withdrawal = reconcileTarget;
    const trimmed = reconcileNote.trim();
    const evidenceFileId = reconcileEvidenceId ?? undefined;
    const action: PendingMfaAction = {
      purpose: 'PAYOUT_RECONCILIATION',
      scopeId: withdrawal.id,
      title: 'Authorize reconciliation — MFA',
      description: <MfaOperationDescription withdrawal={withdrawal} operation="Reconcile" />,
      run: (challenge) => {
        reconcile.mutate(
          {
            id: withdrawal.id,
            ...(evidenceFileId ? { evidenceFileId } : {}),
            ...(trimmed ? { note: trimmed } : {}),
            challenge,
          },
          {
            onSuccess: () => toast.success(`Reconciliation recorded for ${withdrawal.publicRef}`),
            onError: (error) => handleMutationError(error, 'Could not record reconciliation — refresh to confirm', action),
          },
        );
      },
    };
    setReconcileTarget(null);
    setReconcileEvidenceId(null);
    setReconcileNote('');
    setMfaAction(action);
  };

  const openRetryMfa = (w: Withdrawal) => {
    const action: PendingMfaAction = {
      purpose: 'PAYOUT_RETRY',
      scopeId: w.id,
      title: 'Authorize payout retry — MFA',
      description: <MfaOperationDescription withdrawal={w} operation="Retry the failed transfer for" />,
      run: (challenge) => {
        retry.mutate(
          { id: w.id, challenge },
          {
            onSuccess: (res) => toast.success(`Retry started for ${w.publicRef} (attempt ${res.attemptNo})`),
            onError: (error) => handleMutationError(error, 'Could not retry the payout — refresh to confirm', action),
          },
        );
      },
    };
    setMfaAction(action);
  };

  const anyNotePending = requireInfo.isPending || secondApproval.isPending || reject.isPending;

  const renderRowActions = (w: Withdrawal) => {
    const attempts = w.payoutAttempts ?? [];
    const latestAttempt = attempts[0] ?? null;
    const noAttemptHint = 'No provider payout attempt has been recorded yet — verification is available once the transfer is initiated with the provider.';

    if (w.status === 'PENDING' || w.status === 'UNDER_REVIEW' || w.status === 'REQUIRES_INFORMATION') {
      return (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={underReview.isPending}
            onClick={() => openUnderReviewMfa(w)}
            aria-label={`Start review for ${w.publicRef}`}
          >
            <ClipboardList className="h-4 w-4" aria-hidden="true" />
            Review
          </Button>
          {w.status !== 'REQUIRES_INFORMATION' && (
            <Button
              size="sm"
              className="min-h-11"
              disabled={approve.isPending}
              onClick={() => openApproveMfa(w)}
              aria-label={`Approve ${w.publicRef}`}
            >
              <BadgeCheck className="h-4 w-4" aria-hidden="true" />
              Approve
            </Button>
          )}
          {w.status !== 'REQUIRES_INFORMATION' && (
            <Button
              size="sm"
              variant="outline"
              className="min-h-11"
              disabled={requireInfo.isPending}
              onClick={() => openNoteDialog('require-info', w)}
              aria-label={`Request more information for ${w.publicRef}`}
            >
              <MessageSquareWarning className="h-4 w-4" aria-hidden="true" />
              Require info
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={reject.isPending}
            onClick={() => openNoteDialog('reject', w)}
            aria-label={`Reject ${w.publicRef}`}
          >
            <Ban className="h-4 w-4" aria-hidden="true" />
            Reject
          </Button>
        </div>
      );
    }

    if (w.status === 'APPROVED') {
      return (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!w.secondApprovedAt && (
            <Button
              size="sm"
              variant="outline"
              className="min-h-11"
              disabled={secondApproval.isPending}
              onClick={() => openNoteDialog('second-approval', w)}
              aria-label={`Record second approval for ${w.publicRef}`}
            >
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              2nd approval
            </Button>
          )}
          <Button
            size="sm"
            className="min-h-11"
            disabled={settle.isPending}
            onClick={() => openSettleMfa(w)}
            aria-label={`Settle ${w.publicRef}`}
          >
            <Banknote className="h-4 w-4" aria-hidden="true" />
            Settle
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={reject.isPending}
            onClick={() => openNoteDialog('reject', w)}
            aria-label={`Reject ${w.publicRef}`}
          >
            <Ban className="h-4 w-4" aria-hidden="true" />
            Reject
          </Button>
        </div>
      );
    }

    if (w.status === 'PROCESSING' || w.status === 'REQUIRES_RECONCILIATION') {
      return (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {latestAttempt ? (
            <Button
              size="sm"
              variant="outline"
              className="min-h-11"
              disabled={verifyAttempt.isPending}
              onClick={() => openVerifyMfa(w)}
              aria-label={`Verify provider payout attempt for ${w.publicRef}`}
            >
              <RefreshCcw className="h-4 w-4" aria-hidden="true" />
              Verify attempt
            </Button>
          ) : (
            <span title={noAttemptHint}>
              <Button
                size="sm"
                variant="outline"
                className="min-h-11"
                disabled
                aria-label={`Verify provider payout attempt for ${w.publicRef} (unavailable — no attempt recorded yet)`}
              >
                <RefreshCcw className="h-4 w-4" aria-hidden="true" />
                Verify attempt
              </Button>
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={reconcile.isPending}
            onClick={() => openReconcileDialog(w)}
            aria-label={`Reconcile ${w.publicRef}`}
          >
            <FileSearch className="h-4 w-4" aria-hidden="true" />
            Reconcile
          </Button>
        </div>
      );
    }

    if (w.status === 'FAILED') {
      return (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={retry.isPending}
            onClick={() => openRetryMfa(w)}
            aria-label={`Retry the provider payout for ${w.publicRef}`}
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Retry payout
          </Button>
        </div>
      );
    }

    if (w.status === 'PAID') {
      return (
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={reconcile.isPending || Boolean(w.reconciledAt)}
          onClick={() => openReconcileDialog(w)}
          aria-label={w.reconciledAt ? `Reconciliation already recorded for ${w.publicRef}` : `Reconcile ${w.publicRef}`}
        >
          <FileSearch className="h-4 w-4" aria-hidden="true" />
          {w.reconciledAt ? 'Reconciled' : 'Reconcile'}
        </Button>
      );
    }

    return <span className="text-sm text-muted-foreground">—</span>;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Withdrawals</h2>
          <p className="text-sm text-muted-foreground">
            Payout requests from organizers. Money moves only through the canonical workflow: approval, a
            provider transfer reference, dual approval above the threshold, and fresh MFA on every action.
          </p>
        </div>
        <Tabs value={status} onValueChange={setStatus}>
          <TabsList aria-label="Filter withdrawals by status" className="flex-wrap">
            {TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div
        role="note"
        className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
      >
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="space-y-1">
          <p className="font-semibold">Payout states change only through the canonical workflow</p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              There are no manual status flips — failure and retry decisions require authoritative provider
              verification (Verify attempt / Reconcile).
            </li>
            <li>Every action is authorized with a fresh, single-use MFA challenge bound to that exact payout.</li>
            <li>Settlement additionally requires a provider transfer reference and scanned payout evidence.</li>
          </ul>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={Wallet}
          title="Could not load withdrawals"
          description="Something went wrong while fetching payout requests."
          action={<Button onClick={() => void refetch()}>Try again</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="No withdrawals"
          description={`No payout requests in ${activeTabLabel.toLowerCase()} right now.`}
        />
      ) : (
        <div className="rounded-2xl border bg-card shadow-soft">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Fee</TableHead>
                <TableHead>Net</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Requested</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((w) => {
                const attemptsShown =
                  w.status === 'PROCESSING' || w.status === 'REQUIRES_RECONCILIATION' || w.status === 'FAILED';
                return (
                  <Fragment key={w.id}>
                    <TableRow>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          {attemptsShown && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 shrink-0"
                              onClick={() => setExpandedId(expandedId === w.id ? null : w.id)}
                              aria-expanded={expandedId === w.id}
                              aria-label={`${expandedId === w.id ? 'Hide' : 'Show'} payout attempt details for ${w.publicRef}`}
                            >
                              {expandedId === w.id ? (
                                <ChevronDown className="h-4 w-4" aria-hidden="true" />
                              ) : (
                                <ChevronRight className="h-4 w-4" aria-hidden="true" />
                              )}
                            </Button>
                          )}
                          <code className="font-mono text-xs">{w.publicRef}</code>
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[12rem] truncate">{w.campaign?.title ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap font-semibold tabular-nums">
                        {formatMoney(w.amount, w.currency)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                        {formatMoney(w.feeAmount, w.currency)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-semibold tabular-nums text-primary">
                        {formatMoney(w.netAmount, w.currency)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{w.method}</TableCell>
                      <TableCell className="max-w-[12rem] truncate text-muted-foreground">
                        {destinationSummary(w.destination)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(w.createdAt)}</TableCell>
                      <TableCell>
                        <div className="flex flex-col items-start gap-1.5">
                          <Badge variant={statusVariant(w.status)}>{w.status}</Badge>
                          {w.secondApprovedAt && (
                            <Badge variant="success" aria-label="Second approval recorded">
                              <ShieldCheck className="mr-1 h-3 w-3" aria-hidden="true" />
                              Dual approved
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{renderRowActions(w)}</TableCell>
                    </TableRow>
                    {attemptsShown && expandedId === w.id && (
                      <TableRow key={`${w.id}-attempts`} className="bg-muted/20 hover:bg-muted/20">
                        <TableCell colSpan={10}>
                          <PayoutAttemptList attempts={w.payoutAttempts ?? []} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Fresh-MFA gate — the only dialog open at any moment. */}
      <MfaChallengeDialog
        open={mfaAction !== null}
        purpose={mfaAction?.purpose ?? 'PAYOUT_STATE_CHANGE'}
        scope={(mfaAction ? { kind: 'withdrawal', id: mfaAction.scopeId } : { kind: 'none' }) as MfaChallengeScope}
        title={mfaAction?.title ?? 'Authorize operation'}
        description={mfaAction?.description}
        onAuthorized={(challengeToken) => {
          const run = mfaAction?.run;
          setMfaAction(null);
          run?.(challengeToken);
        }}
        onClose={() => setMfaAction(null)}
      />

      {/* Shared note dialog: reject / require-info / second-approval */}
      <Dialog
        open={noteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setNoteTarget(null);
            setNote('');
          }
        }}
      >
        <DialogContent className="max-w-md rounded-2xl">
          {noteTarget && (
            <>
              <DialogHeader>
                <DialogTitle>{NOTE_ACTIONS[noteTarget.kind].title}</DialogTitle>
                <DialogDescription>
                  {noteTarget.kind === 'reject' &&
                    `${noteTarget.withdrawal.campaign?.title ?? noteTarget.withdrawal.publicRef} — add a note explaining why. The organizer can correct details and request again.`}
                  {noteTarget.kind === 'require-info' &&
                    'Tell the organizer exactly what is missing (bank statement, beneficiary consent, proof of address…). The payout pauses until they respond.'}
                  {noteTarget.kind === 'second-approval' &&
                    `You are confirming the payout of ${formatMoney(noteTarget.withdrawal.amount, noteTarget.withdrawal.currency)} (${noteTarget.withdrawal.publicRef}) as the second approver. Your name is recorded for the audit trail.`}
                  {' '}You will confirm with a fresh MFA challenge next.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="action-note">Note</Label>
                <Textarea
                  id="action-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="At least 3 characters"
                  className="min-h-[100px]"
                  aria-label="Note"
                  aria-invalid={Boolean(note) && noteError(note) !== null}
                />
                {noteError(note) && (
                  <p role="alert" className="text-xs font-medium text-destructive">{noteError(note)}</p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setNoteTarget(null);
                    setNote('');
                  }}
                  className="min-h-11"
                >
                  Cancel
                </Button>
                <Button
                  variant={NOTE_ACTIONS[noteTarget.kind].destructive ? 'destructive' : 'default'}
                  disabled={Boolean(noteError(note)) || anyNotePending}
                  onClick={submitNoteAction}
                  className="min-h-11"
                >
                  {anyNotePending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  {NOTE_ACTIONS[noteTarget.kind].cta}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reconcile dialog (PROCESSING / PAID): optional note + optional evidence file */}
      <Dialog
        open={reconcileTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setReconcileTarget(null);
            setReconcileNote('');
            setReconcileEvidenceId(null);
          }
        }}
      >
        <DialogContent className="max-w-md rounded-2xl">
          {reconcileTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reconcile payout</DialogTitle>
                <DialogDescription>
                  Reconciling{' '}
                  <code className="font-mono text-xs">{reconcileTarget.publicRef}</code> (
                  {formatMoney(reconcileTarget.amount, reconcileTarget.currency)}). Attach evidence for the
                  provider transfer if you have it — financial records are never altered, this only documents
                  the settlement. You will confirm with a fresh MFA challenge next.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <EvidenceFilePicker
                  idPrefix="reconcile"
                  fileId={reconcileEvidenceId}
                  onFileIdChange={setReconcileEvidenceId}
                  onReadinessChange={setReconcileEvidenceReadySafe}
                  optional
                />
                <div className="space-y-2">
                  <Label htmlFor="reconcile-note">Note (optional)</Label>
                  <Textarea
                    id="reconcile-note"
                    value={reconcileNote}
                    onChange={(e) => setReconcileNote(e.target.value)}
                    placeholder="e.g. Confirmed against GTB statement for March"
                    className="min-h-[80px]"
                    aria-label="Reconciliation note (optional)"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setReconcileTarget(null);
                    setReconcileEvidenceId(null);
                    setReconcileNote('');
                  }}
                  className="min-h-11"
                >
                  Cancel
                </Button>
                <Button
                  onClick={submitReconcile}
                  disabled={reconcile.isPending || (reconcileEvidenceId !== null && !reconcileEvidenceReady)}
                  className="min-h-11"
                >
                  {reconcile.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  Continue to MFA
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Settlement form dialog — opens only AFTER MFA authorizes PAYOUT_SETTLEMENT */}
      <Dialog
        open={settleTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSettleTarget(null);
            setSettleServerError(null);
          }
        }}
      >
        <DialogContent className="max-w-md rounded-2xl">
          {settleTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Settle payout — record the transfer</DialogTitle>
                <DialogDescription>
                  <span className="block">
                    Settlement of{' '}
                    <code className="font-mono text-xs">{settleTarget.withdrawal.publicRef}</code> —{' '}
                    <strong>{formatMoney(settleTarget.withdrawal.amount, settleTarget.withdrawal.currency)}</strong>{' '}
                    (net {formatMoney(settleTarget.withdrawal.netAmount, settleTarget.withdrawal.currency)}).
                  </span>
                  The provider transfer reference is the proof of settlement; the evidence file is stored
                  privately. The ledger posting is exactly-once — a duplicate settlement is rejected.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="settle-provider">Payout provider</Label>
                  <Select
                    value={settleForm.payoutProvider}
                    onValueChange={(value) => setSettleForm((form) => ({ ...form, payoutProvider: value }))}
                  >
                    <SelectTrigger
                      id="settle-provider"
                      className="min-h-11"
                      aria-invalid={Boolean(settleErrors.payoutProvider)}
                    >
                      <SelectValue placeholder="Choose the channel the money was sent through" />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYOUT_PROVIDERS.map((provider) => (
                        <SelectItem key={provider} value={provider}>
                          {PAYOUT_PROVIDER_LABELS[provider] ?? provider}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {settleErrors.payoutProvider && (
                    <p role="alert" className="text-xs font-medium text-destructive">{settleErrors.payoutProvider}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="settle-transfer-ref">Provider transfer reference</Label>
                  <Input
                    id="settle-transfer-ref"
                    value={settleForm.providerTransferRef}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setSettleForm((form) => ({ ...form, providerTransferRef: e.target.value }))
                    }
                    placeholder="e.g. TRF-88H2K4M9"
                    className="min-h-11 font-mono"
                    aria-label="Provider transfer reference"
                    aria-invalid={Boolean(settleErrors.providerTransferRef)}
                  />
                  {settleErrors.providerTransferRef && (
                    <p role="alert" className="text-xs font-medium text-destructive">
                      {settleErrors.providerTransferRef}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="settle-txn-id">Provider transaction id (optional)</Label>
                  <Input
                    id="settle-txn-id"
                    value={settleForm.payoutProviderTxnId}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setSettleForm((form) => ({ ...form, payoutProviderTxnId: e.target.value }))
                    }
                    placeholder="Provider-side id, if different"
                    className="min-h-11 font-mono"
                    aria-label="Provider transaction id (optional)"
                  />
                </div>
                <EvidenceFilePicker
                  idPrefix="settle"
                  fileId={settleForm.evidenceFileId || null}
                  onFileIdChange={(fileId) => setSettleForm((form) => ({ ...form, evidenceFileId: fileId ?? '' }))}
                  onReadinessChange={setSettleEvidenceReadySafe}
                />
                {settleServerError && (
                  <p
                    role="alert"
                    className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-destructive"
                  >
                    {settleServerError}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setSettleTarget(null);
                    setSettleServerError(null);
                  }}
                  className="min-h-11"
                >
                  Cancel
                </Button>
                <Button
                  onClick={submitSettle}
                  disabled={settle.isPending || !settleEvidenceReady}
                  className="min-h-11"
                >
                  {settle.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Banknote className="h-4 w-4" aria-hidden="true" />
                  )}
                  Post settlement
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
