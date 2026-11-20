import { useEffect, useState } from 'react';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';

import {
  useMfaChallenge, useMfaConfirm, useMfaEnroll, useMfaStatus,
  type MfaPurpose,
} from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

/** The operation the challenge token will be bound to (scope binding, v1.0.4 §7). */
export type MfaChallengeScope = { kind: 'withdrawal'; id: string } | { kind: 'none' };

interface MfaChallengeDialogProps {
  open: boolean;
  purpose: MfaPurpose;
  scope: MfaChallengeScope;
  title: string;
  /** ReactNode — callers display the withdrawal publicRef + amount here so the
   * administrator confirms the exact operation before authorizing (§7.4). */
  description?: React.ReactNode;
  /** Receives the single-use challenge token on success. */
  onAuthorized: (challengeToken: string) => void;
  /** Called when the administrator dismisses the dialog. */
  onClose: () => void;
}

type Step = 'loading' | 'enroll' | 'challenge';

/**
 * Fresh-MFA gate for money-moving payout operations (v1.0.4 §7). Exchanges the
 * administrator's CURRENT TOTP code for a single-use challenge token bound to
 * (purpose, scope). A token authorizes exactly ONE operation on the exact
 * withdrawal id given as scope. Admins without a confirmed authenticator are
 * walked through enrollment first (enroll -> confirm -> challenge).
 */
export function MfaChallengeDialog({ open, purpose, scope, title, description, onAuthorized, onClose }: MfaChallengeDialogProps) {
  const status = useMfaStatus();
  const enroll = useMfaEnroll();
  const confirm = useMfaConfirm();
  const challenge = useMfaChallenge();

  const [step, setStep] = useState<Step>('loading');
  const [code, setCode] = useState('');
  const [enrolled, setEnrolled] = useState<{ otpauthUri: string; secret: string } | null>(null);

  // Reset the whole flow every time the dialog is (re)opened — challenge
  // tokens and codes are single-use and must never survive a close/open cycle.
  useEffect(() => {
    if (open) {
      setStep('loading');
      setCode('');
      setEnrolled(null);
      enroll.reset();
      confirm.reset();
      challenge.reset();
      status.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || status.isLoading) return;
    const mfa = status.data;
    setStep(mfa && mfa.enrolled && mfa.active ? 'challenge' : 'enroll');
  }, [open, status.data, status.isLoading]);

  const scopeId = scope.kind === 'withdrawal' ? scope.id : undefined;
  const busy = enroll.isPending || confirm.isPending || challenge.isPending;
  const error =
    challenge.error instanceof Error ? challenge.error.message
      : confirm.error instanceof Error ? confirm.error.message
        : enroll.error instanceof Error ? enroll.error.message
          : status.error instanceof Error ? status.error.message
            : null;

  const submitChallenge = () => {
    if (code.trim().length < 6) return;
    challenge.mutate(
      { purpose, ...(scopeId ? { scope: scopeId } : {}), code: code.trim() },
      { onSuccess: (res) => onAuthorized(res.challengeToken) },
    );
  };

  const startEnrollment = () => {
    enroll.mutate(undefined, { onSuccess: (res) => setEnrolled({ otpauthUri: res.otpauthUri, secret: res.secret }) });
  };

  const submitEnrollment = () => {
    if (code.trim().length < 6) return;
    confirm.mutate(
      { code: code.trim() },
      { onSuccess: () => { setCode(''); setStep('challenge'); } },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              {description}
              <span className="block">
                Confirm your authenticator code to receive a single-use authorization. It is valid for this
                operation only, on this exact payout, and expires within minutes.
              </span>
            </div>
          </DialogDescription>
        </DialogHeader>

        {step === 'loading' ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : step === 'enroll' ? (
          <div className="space-y-4">
            {!enrolled ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Your account does not have a confirmed authenticator yet. Set one up now — payout operations
                  cannot proceed without fresh MFA.
                </p>
                <Button onClick={startEnrollment} disabled={busy} className="min-h-11 w-full">
                  {enroll.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
                  Set up authenticator
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="mfa-secret">One-time secret (shown only once)</Label>
                  <code
                    id="mfa-secret"
                    className="block break-all rounded-lg border bg-muted/50 p-3 font-mono text-sm"
                  >
                    {enrolled.secret}
                  </code>
                  <p className="text-xs text-muted-foreground">
                    Add it to your authenticator app (manual entry), or use the setup URI:{' '}
                    <code className="break-all font-mono">{enrolled.otpauthUri}</code>
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mfa-confirm-code">Confirm with a code from the app</Label>
                  <Input
                    id="mfa-confirm-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    className="min-h-11 text-center font-mono tracking-[0.4em]"
                    aria-invalid={Boolean(code) && code.trim().length < 6}
                    autoFocus
                  />
                </div>
                <Button
                  onClick={submitEnrollment}
                  disabled={busy || code.trim().length < 6}
                  className="min-h-11 w-full"
                >
                  {confirm.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  Confirm authenticator
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mfa-challenge-code">Authenticator code</Label>
              <Input
                id="mfa-challenge-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                className="min-h-11 text-center font-mono tracking-[0.4em]"
                aria-invalid={Boolean(code) && code.trim().length < 6}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitChallenge();
                }}
              />
            </div>
            <Button
              onClick={submitChallenge}
              disabled={busy || code.trim().length < 6}
              className="min-h-11 w-full"
            >
              {challenge.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
              Authorize operation
            </Button>
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy} className="min-h-11">
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default MfaChallengeDialog;
