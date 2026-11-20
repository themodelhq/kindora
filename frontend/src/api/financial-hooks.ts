import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ApiError, API_BASE_URL, API_PREFIX, api, apiWithHeaders } from '@/lib/http';
import { isDemoMode } from '@/lib/demo/adapter';
import { useAuthStore } from '@/stores/auth-store';

/**
 * Financial Control & Reconciliation Centre hooks (admin only).
 *
 * Mirrors the query conventions of @/api/hooks.ts but lives in its own file —
 * hooks.ts is owned by another task and is intentionally NOT edited here.
 * All amounts arrive from the API as STRINGS in minor units.
 */

export const FINANCIAL_REPORT_TYPES = [
  'daily-closing',
  'campaign-balances',
  'withdrawals',
  'refunds',
  'platform-fees',
] as const;
export type FinancialReportType = (typeof FINANCIAL_REPORT_TYPES)[number];

export type PaymentAnomaly =
  | 'PROVIDER_MISMATCH'
  | 'AMOUNT_UNVERIFIED'
  | 'REFERENCE_NOT_FOUND'
  | 'UNKNOWN_EVENT'
  | 'DUPLICATE'
  | 'OK';

// ---------- response types ----------

export interface FinancialCurrencySummary {
  currency: string;
  donationsInitiated: { count: number; amountMinor: string };
  donationsSucceeded: { count: number; amountMinor: string; feesMinor: string; tipsMinor: string };
  donationsPending: { count: number; amountMinor: string };
  donationsFailed: { count: number };
  donationsRefunded: { count: number; amountMinor: string };
  recurringActive: { count: number; monthlyMinor: string };
  recurringFailures: { count: number; lastFailureAt: string | null };
  campaignLiabilityMinor: string;
  reservedForWithdrawalsMinor: string;
  paidWithdrawalsMinor: string;
  outstandingPayoutLiabilityMinor: string;
  platformRevenueMinor: string;
  providerFeesMinor: string;
  clearingMinor: string;
}

export interface FinancialSummary {
  from: string;
  to: string;
  disputesOpen: number;
  currencies: FinancialCurrencySummary[];
}

export interface PaymentReconciliationRow {
  id: string;
  provider: string;
  eventType: string | null;
  reference: string | null;
  eventId: string | null;
  signatureValid: boolean;
  status: string;
  handledAction: string | null;
  processedAt: string | null;
  createdAt: string;
  donationState: { publicRef: string; status: string; provider: string } | null;
  anomaly: PaymentAnomaly;
}

export interface PaymentReconciliation {
  from: string;
  to: string;
  total: number;
  page: number;
  pageSize: number;
  counts: Record<PaymentAnomaly, number>;
  items: PaymentReconciliationRow[];
}

export interface WithdrawalReconciliationRow {
  id: string;
  publicRef: string;
  status: string;
  currency: string;
  amountMinor: string;
  netAmountMinor: string;
  payoutProvider: string | null;
  providerTransferRef: string | null;
  payoutProviderTxnId: string | null;
  paidAt: string | null;
  reconciledAt: string | null;
  campaign: { title: string; slug: string } | null;
  needsReconciliation: boolean;
  missingEvidence: boolean;
}

export interface WithdrawalReconciliation {
  total: number;
  page: number;
  pageSize: number;
  summary: {
    paid: number;
    awaitingReconciliation: number;
    failed: number;
    rejected: number;
    outstandingReservationMinor: Record<string, string>;
  };
  items: WithdrawalReconciliationRow[];
}

export interface LedgerIntegrity {
  checkedAt: string;
  transactionsChecked: number;
  violations: {
    unbalancedTxns: string[];
    campaignMismatches: {
      campaignId: string;
      currency: string;
      ledgerBalanceMinor: string;
      expectedMinor: string;
    }[];
    chargeMismatches: string[];
    referenceStats: { transactions: number; uniqueReferences: number; consistent: boolean };
  };
  ok: boolean;
}

export interface FinancialAuditRow {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
  ip: string | null;
  createdAt: string;
  actor: { email: string; firstName: string; lastName: string } | null;
}

export interface FinancialAudit {
  total: number;
  page: number;
  pageSize: number;
  items: FinancialAuditRow[];
}

// ---------- query keys ----------

const KEY = {
  summary: (filters: FinancialFilters) => ['financial-summary', filters] as const,
  payments: (filters: PaymentReconciliationFilters) => ['financial-payments', filters] as const,
  withdrawals: (page: number) => ['financial-withdrawals', page] as const,
  ledgerIntegrity: ['financial-ledger-integrity'] as const,
  audit: (page: number, action: string) => ['financial-audit', page, action] as const,
};

export interface FinancialFilters {
  from?: string;
  to?: string;
  provider?: string;
}

function toSearch(params: object): string {
  return new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
}

// ---------- hooks ----------

export function useFinancialSummary(filters: FinancialFilters) {
  const search = toSearch(filters);
  return useQuery({
    queryKey: KEY.summary(filters),
    queryFn: () => api<FinancialSummary>('GET', `/admin/financial/summary?${search}`),
    placeholderData: keepPreviousData,
  });
}

export interface PaymentReconciliationFilters extends FinancialFilters {
  status?: string;
  page?: number;
}

export function usePaymentReconciliation(filters: PaymentReconciliationFilters) {
  const search = toSearch(filters);
  return useQuery({
    queryKey: KEY.payments(filters),
    queryFn: () => api<PaymentReconciliation>('GET', `/admin/financial/reconciliation/payments?${search}`),
    placeholderData: keepPreviousData,
  });
}

export function useWithdrawalReconciliation(page = 1) {
  return useQuery({
    queryKey: KEY.withdrawals(page),
    queryFn: () => api<WithdrawalReconciliation>('GET', `/admin/financial/reconciliation/withdrawals?page=${page}`),
    placeholderData: keepPreviousData,
  });
}

/**
 * The integrity sweep runs server-side on every fetch; the "Run check" button
 * simply refetches this query.
 */
export function useLedgerIntegrity() {
  return useQuery({
    queryKey: KEY.ledgerIntegrity,
    queryFn: () => api<LedgerIntegrity>('GET', '/admin/financial/reconciliation/ledger-integrity'),
    staleTime: 30_000,
  });
}

export function useFinancialAudit(page = 1, action = '') {
  return useQuery({
    queryKey: KEY.audit(page, action),
    queryFn: () => api<FinancialAudit>('GET', `/admin/financial/audit?${toSearch({ page, action })}`),
    placeholderData: keepPreviousData,
  });
}

// ---------- CSV report download ----------

/**
 * Downloads an admin CSV report as a Blob. The api() helper only returns
 * parsed JSON, so this uses fetch() directly with the access token from the
 * auth store. Throws ApiError on failure (including demo mode, where there is
 * no real API to hit).
 */
export async function downloadFinancialCsv(type: FinancialReportType): Promise<void> {
  if (isDemoMode()) {
    throw new ApiError('Report downloads are not available in demo mode', 0);
  }
  const token = useAuthStore.getState().accessToken;
  const response = await fetch(`${API_BASE_URL}${API_PREFIX}/admin/financial/reports/${type}.csv`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    credentials: 'include',
  });
  if (!response.ok) {
    throw new ApiError(`Report download failed (HTTP ${response.status})`, response.status);
  }
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const filenameMatch = /filename="([^"]+)"/.exec(disposition);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filenameMatch?.[1] ?? `kindora-${type}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- v1.0.7 payout execution & manual review ----------

export interface ManualReviewCase {
  id: string;
  withdrawalId: string;
  attemptId: string | null;
  category: string;
  status: 'OPEN' | 'RESOLVED';
  openedReason: string;
  resolution: string | null;
  resolutionNote: string | null;
  resolvedById: string | null;
  reviewerId: string | null;
  mfaPurposeUsed: string | null;
  createdAt: string;
  updatedAt: string;
  attempt?: { id: string; attemptNo: number; provider: string; status: string; providerTransferRef: string | null } | null;
}

export function useManualReviewCases(status?: 'OPEN' | 'RESOLVED') {
  const token = useAuthStore.getState().accessToken;
  return useQuery({
    queryKey: ['admin', 'review-cases', status ?? 'ALL'],
    enabled: !isDemoMode() && Boolean(token),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const res = await api<{ total: number; items: ManualReviewCase[] }>(
        'GET',
        `/withdrawals/review-cases${status ? `?status=${status}` : ''}`,
      );
      return { total: res.total, items: res.items };
    },
  });
}

/** Resolve a manual review case — requires a fresh PAYOUT_MANUAL_REVIEW MFA token. */
export async function resolveManualReviewCase(args: {
  caseId: string;
  resolution: 'RETURN_TO_VERIFICATION' | 'CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE' | 'RECORD_REVERSAL_DECISION' | 'NO_INTERNAL_CHANGE';
  note: string;
  evidenceFileId?: string;
  reviewerId?: string;
  mfaToken: string;
}): Promise<void> {
  await apiWithHeaders<ManualReviewCase>(
    'POST',
    `/withdrawals/review-cases/${args.caseId}/resolve`,
    {
      resolution: args.resolution,
      note: args.note,
      ...(args.evidenceFileId ? { evidenceFileId: args.evidenceFileId } : {}),
      ...(args.reviewerId ? { reviewerId: args.reviewerId } : {}),
    },
    { 'x-mfa-challenge': args.mfaToken },
  );
}

/** Execute a payout through a real provider transfer — requires fresh PAYOUT_EXECUTION MFA. */
export async function executePayout(args: { withdrawalId: string; payoutProvider: 'PAYSTACK' | 'FLUTTERWAVE'; mfaToken: string }): Promise<{ id: string; attemptNo: number; status: string }> {
  const res = await apiWithHeaders<{ id: string; attemptNo: number; status: string }>(
    'POST',
    `/withdrawals/${args.withdrawalId}/execute`,
    { payoutProvider: args.payoutProvider },
    { 'x-mfa-challenge': args.mfaToken },
  );
  return { id: res.id, attemptNo: res.attemptNo, status: res.status };
}
