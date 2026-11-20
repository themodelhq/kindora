import type { BadgeProps } from '@/components/ui/badge';
import type { CampaignStatus, DonationStatus, Withdrawal } from '@/types/api';

type BadgeVariant = NonNullable<BadgeProps['variant']>;

export interface StatusView {
  label: string;
  variant: BadgeVariant;
}

/** Maps a campaign status to a friendly label + badge variant. */
export function campaignStatusBadge(status: CampaignStatus): StatusView {
  switch (status) {
    case 'DRAFT':
      return { label: 'Draft', variant: 'muted' };
    case 'PENDING_REVIEW':
      return { label: 'Pending review', variant: 'warning' };
    case 'ACTIVE':
      return { label: 'Active', variant: 'success' };
    case 'PAUSED':
      return { label: 'Paused', variant: 'secondary' };
    case 'COMPLETED':
      return { label: 'Completed', variant: 'default' };
    case 'REJECTED':
      return { label: 'Rejected', variant: 'destructive' };
    case 'SUSPENDED':
      return { label: 'Suspended', variant: 'destructive' };
    default:
      return { label: status, variant: 'muted' };
  }
}

/** Maps a donation status to a friendly label + badge variant. */
export function donationStatusBadge(status: DonationStatus): StatusView {
  switch (status) {
    case 'SUCCEEDED':
      return { label: 'Succeeded', variant: 'success' };
    case 'PENDING':
      return { label: 'Pending', variant: 'warning' };
    case 'FAILED':
      return { label: 'Failed', variant: 'destructive' };
    case 'REFUNDED':
      return { label: 'Refunded', variant: 'destructive' };
    case 'PARTIALLY_REFUNDED':
      return { label: 'Partly refunded', variant: 'warning' };
    case 'CANCELLED':
      return { label: 'Cancelled', variant: 'muted' };
    default:
      return { label: status, variant: 'muted' };
  }
}

/** Maps a withdrawal status to a friendly label + badge variant. */
export function withdrawalStatusBadge(status: Withdrawal['status']): StatusView {
  switch (status) {
    case 'PENDING':
      return { label: 'Pending', variant: 'warning' };
    case 'UNDER_REVIEW':
      return { label: 'Under review', variant: 'warning' };
    case 'REQUIRES_INFORMATION':
      return { label: 'Needs info', variant: 'warning' };
    case 'APPROVED':
      return { label: 'Approved', variant: 'secondary' };
    case 'PROCESSING':
      return { label: 'Processing', variant: 'secondary' };
    case 'PAID':
      return { label: 'Paid', variant: 'success' };
    case 'REJECTED':
      return { label: 'Rejected', variant: 'destructive' };
    case 'FAILED':
      return { label: 'Failed', variant: 'destructive' };
    case 'CANCELLED':
      return { label: 'Cancelled', variant: 'muted' };
    case 'REQUIRES_RECONCILIATION':
      return { label: 'Reconciliation required', variant: 'warning' };
    case 'REVERSED':
      return { label: 'Reversed', variant: 'destructive' };
    default:
      return { label: status, variant: 'muted' };
  }
}

/**
 * v1.0.7 §16 — payout attempt states exactly mirror the backend's durable
 * initiation state machine, so administrators can distinguish a locally
 * registered intent from a provider-accepted transfer awaiting verification.
 */
export type PayoutAttemptStatusView =
  | 'INITIATED'
  | 'SUBMISSION_PENDING'
  | 'PROVIDER_ACCEPTED'
  | 'PENDING'
  | 'SUCCESSFUL'
  | 'FAILED'
  | 'UNKNOWN'
  | 'REVERSED'
  | 'MANUAL_REVIEW'
  | string;

export function payoutAttemptStatusBadge(status: PayoutAttemptStatusView): StatusView {
  switch (status) {
    case 'INITIATED':
      return { label: 'Ready for execution', variant: 'secondary' };
    case 'SUBMISSION_PENDING':
      return { label: 'Initiation pending (ambiguous)', variant: 'warning' };
    case 'PROVIDER_ACCEPTED':
      return { label: 'Provider accepted', variant: 'secondary' };
    case 'PENDING':
      return { label: 'Verification pending', variant: 'warning' };
    case 'SUCCESSFUL':
      return { label: 'Successfully verified', variant: 'success' };
    case 'FAILED':
      return { label: 'Failed', variant: 'destructive' };
    case 'UNKNOWN':
      return { label: 'Unknown — reconciling', variant: 'warning' };
    case 'REVERSAL_IN_PROGRESS':
      // v1.0.8 §8.2 — an in-progress reversal is NOT a completed reversal.
      return { label: 'Reversal in progress', variant: 'warning' };
    case 'REVERSED':
      return { label: 'Reversed (completed)', variant: 'destructive' };
    case 'MANUAL_REVIEW':
      return { label: 'Manual review required', variant: 'destructive' };
    default:
      return { label: status, variant: 'muted' };
  }
}

/** v1.0.7 §16 — human explanation for blocked automatic settlement. */
export function settlementBlockedExplanation(attempt: { classification?: string | null; providerStatus?: string | null }): string | null {
  if (attempt.providerStatus === 'PROVIDER_UNAVAILABLE') {
    return 'Automatic settlement is blocked: the provider API could not be reached, so the transfer outcome is not yet verified. The funds reservation is intact; reconciliation will retry and escalate to manual review if the uncertainty persists.';
  }
  switch (attempt.classification) {
    case 'PROVIDER_DATA_INCOMPLETE':
      return 'Automatic settlement is blocked: the provider did not report the amount, currency or beneficiary identity needed to prove this transfer belongs to this withdrawal. Fail-closed policy keeps the reservation and opens a manual review case.';
    case 'AMOUNT_MISMATCH':
      return 'Automatic settlement is blocked: the provider-reported amount does not exactly match the approved withdrawal amount (integer minor units are compared). A manual review case has been opened.';
    case 'CURRENCY_MISMATCH':
      return 'Automatic settlement is blocked: the provider-reported currency does not match the approved currency. Currency conversion is never silently assumed. A manual review case has been opened.';
    case 'DESTINATION_MISMATCH':
      return 'Automatic settlement is blocked: the provider-reported beneficiary does not match the approved destination. A manual review case has been opened.';
    case 'REFERENCE_MISMATCH':
    case 'DUPLICATE_REFERENCE':
      return 'Automatic settlement is blocked: the provider reference cannot be tied to this payout attempt uniquely. A manual review case has been opened.';
    case 'MANUAL_CONFIRMED_WITH_EVIDENCE':
      return 'A manual review resolution recorded independent evidence. Settlement still requires authoritative provider verification or the controlled manual-settlement approval path.';
    default:
      return null;
  }
}
