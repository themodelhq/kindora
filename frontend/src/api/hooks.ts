import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiWithHeaders } from '@/lib/http';
import { useAuthStore } from '@/stores/auth-store';
import type {
  AdminStats, AiGeneration, CampaignDetail, CampaignSummary, Circle, Donation,
  ImpactSummary, LedgerTransactionView, Notification, Organization, Paginated, PaymentMethod,
  ConfirmUploadResponse, StoredFile, UploadRegistration, User, Withdrawal, DonorEntry, CampaignUpdate,
} from '@/types/api';

const KEY = {
  me: ['me'] as const,
  campaigns: (params: Record<string, unknown>) => ['campaigns', params] as const,
  campaign: (slug: string) => ['campaign', slug] as const,
  updates: (slug: string) => ['updates', slug] as const,
  donors: (slug: string) => ['donors', slug] as const,
  myCampaigns: ['campaigns', 'mine'] as const,
  impact: ['impact-summary'] as const,
  impactTx: (page: number) => ['impact-tx', page] as const,
  campaignLedger: (slug: string) => ['campaign-ledger', slug] as const,
  methods: ['payment-methods'] as const,
  donation: (ref: string) => ['donation', ref] as const,
  donationStatus: (provider: string, ref: string) => ['donation-status', provider, ref] as const,
  myDonations: ['donations', 'mine'] as const,
  notifications: ['notifications'] as const,
  withdrawals: ['withdrawals'] as const,
  available: (campaignId: string) => ['available', campaignId] as const,
  availableAll: ['available'] as const,
  myFiles: (page: number) => ['storage', 'mine', page] as const,
  circles: ['circles'] as const,
  circle: (slug: string) => ['circle', slug] as const,
  organizations: ['organizations'] as const,
  organization: (slug: string) => ['organization', slug] as const,
  adminStats: ['admin-stats'] as const,
  adminCampaigns: (status: string) => ['admin-campaigns', status] as const,
  adminUsers: ['admin-users'] as const,
  adminWithdrawals: (status: string) => ['admin-withdrawals', status] as const,
  adminTransactions: (page: number) => ['admin-transactions', page] as const,
  adminModeration: ['admin-moderation'] as const,
  adminFraud: ['admin-fraud'] as const,
  ai: ['ai-generations'] as const,
};

// ---------- public ----------

export function useCampaigns(params: Record<string, unknown>) {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null).map(([k, v]) => [k, String(v)]),
  ).toString();
  return useQuery({
    queryKey: KEY.campaigns(params),
    queryFn: () => api<Paginated<CampaignSummary>>('GET', `/campaigns?${search}`),
    placeholderData: keepPreviousData,
  });
}

export function useCampaign(slug: string) {
  return useQuery({
    queryKey: KEY.campaign(slug),
    queryFn: () => api<CampaignDetail>('GET', `/campaigns/${slug}`),
    enabled: Boolean(slug),
  });
}

export function useCampaignUpdates(slug: string) {
  return useQuery({
    queryKey: KEY.updates(slug),
    queryFn: () => api<Paginated<CampaignUpdate>>('GET', `/campaigns/${slug}/updates`),
    enabled: Boolean(slug),
  });
}

export function useCampaignDonors(slug: string, page = 1) {
  return useQuery({
    queryKey: [...KEY.donors(slug), page],
    queryFn: () => api<Paginated<DonorEntry>>('GET', `/donations/campaigns/${slug}/donors?page=${page}`),
    enabled: Boolean(slug),
    placeholderData: keepPreviousData,
  });
}

export function useImpactSummary() {
  return useQuery({ queryKey: KEY.impact, queryFn: () => api<ImpactSummary>('GET', '/impact/summary') });
}

export function useImpactTransactions(page = 1) {
  return useQuery({
    queryKey: KEY.impactTx(page),
    queryFn: () => api<Paginated<LedgerTransactionView>>('GET', `/impact/transactions?page=${page}`),
    placeholderData: keepPreviousData,
  });
}

export function useCampaignLedger(slug: string) {
  return useQuery({
    queryKey: KEY.campaignLedger(slug),
    queryFn: () => api<{ campaign: { title: string; currency: string; raisedAmount: string; targetAmount: string }; balanceMinor: string; entries: { direction: string; amount: string; currency: string; transaction: { type: string; postedAt: string; description?: string } }[]; paidWithdrawals: { publicRef: string; netAmount: string; paidAt: string }[] }>('GET', `/impact/campaigns/${slug}`),
    enabled: Boolean(slug),
  });
}

export function usePaymentMethods() {
  return useQuery({ queryKey: KEY.methods, queryFn: () => api<PaymentMethod[]>('GET', '/payments/methods') });
}

export function useDonationStatus(provider: string, ref: string) {
  return useQuery({
    queryKey: KEY.donationStatus(provider, ref),
    queryFn: () => api<Donation>('GET', `/donations/status/${provider}/${ref}`),
    enabled: Boolean(ref),
    refetchInterval: (query) => {
      const data = query.state.data as Donation | undefined;
      return data?.status === 'PENDING' ? 2500 : false;
    },
    refetchIntervalInBackground: false,
  });
}

export function useDonation(ref: string) {
  return useQuery({ queryKey: KEY.donation(ref), queryFn: () => api<Donation>('GET', `/donations/${ref}`), enabled: Boolean(ref) });
}

export interface CreateDonationInput {
  campaignSlug: string;
  amountMinor: number;
  tipAmountMinor?: number;
  provider: string;
  guestEmail?: string;
  guestName?: string;
  isAnonymous?: boolean;
  message?: string;
  recurring?: boolean;
  recurringFrequency?: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
}

export function useCreateDonation() {
  return useMutation({
    mutationFn: (input: CreateDonationInput) =>
      api<{ donation: { publicRef: string; status: string }; redirectUrl: string }>('POST', '/donations', input),
  });
}

// ---------- auth ----------

export function useLogin() {
  const setToken = useAuthStore((s) => s.setAccessToken);
  const setUser = useAuthStore((s) => s.setUser);
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => api<{ accessToken: string; user?: User }>('POST', '/auth/login', input),
    onSuccess: (res) => {
      setToken(res.accessToken);
      if (res.user) setUser(res.user);
      else void useAuthStore.getState().bootstrap();
    },
  });
}

export function useRegister() {
  return useMutation({
    mutationFn: (input: { email: string; password: string; firstName: string; lastName: string }) =>
      api<{ user: User }>('POST', '/auth/register', input),
  });
}

export function useLogout() {
  const clear = useAuthStore((s) => s.clear);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean }>('POST', '/auth/logout'),
    // Local state is ALWAYS cleared — even if the server call fails (offline,
    // 5xx) the user must end up signed out on this device. Server-side
    // revocation failure is retried by the next login/logout cycle.
    onSettled: () => {
      clear();
      qc.clear();
    },
  });
}

export function useVerifyEmail() {
  return useMutation({ mutationFn: (token: string) => api<{ verified: boolean }>('POST', '/auth/verify-email', { token }) });
}

export function useForgotPassword() {
  return useMutation({ mutationFn: (email: string) => api<{ ok: boolean }>('POST', '/auth/forgot-password', { email }) });
}

export function useResetPassword() {
  return useMutation({ mutationFn: (input: { token: string; password: string }) => api<{ ok: boolean }>('POST', '/auth/reset-password', input) });
}

// ---------- user ----------

export function useMyDonations(page = 1) {
  return useQuery({
    queryKey: [...KEY.myDonations, page],
    queryFn: () => api<Paginated<Donation>>('GET', `/donations/mine?page=${page}`),
    placeholderData: keepPreviousData,
  });
}

export function useMyNotifications() {
  return useQuery({ queryKey: KEY.notifications, queryFn: () => api<Paginated<Notification>>('GET', '/users/me/notifications') });
}

export function useMyCampaigns() {
  return useQuery({ queryKey: KEY.myCampaigns, queryFn: () => api<Paginated<CampaignSummary>>('GET', '/campaigns/mine') });
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api<{ campaign: CampaignDetail }>('POST', '/campaigns', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY.myCampaigns }),
  });
}

export function useSubmitCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ campaign: CampaignDetail }>(`POST`, `/campaigns/${id}/submit`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY.myCampaigns });
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}

export function useUpdateCampaign(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api<{ campaign: CampaignDetail }>('PATCH', `/campaigns/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY.myCampaigns });
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}

export function useCreateCampaignUpdate(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; body: string }) => api<{ update: CampaignUpdate }>('POST', `/campaigns/${slug}/updates`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY.updates(slug) });
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}

// ---------- withdrawals ----------

export function useMyWithdrawals() {
  return useQuery({ queryKey: KEY.withdrawals, queryFn: () => api<Paginated<Withdrawal>>('GET', '/withdrawals/mine') });
}

/**
 * Available balance of a campaign. 403 for campaigns the caller does not
 * manage — callers should render a "Not permitted" state instead of retrying.
 */
export function useAvailableBalance(campaignId: string) {
  return useQuery({
    queryKey: KEY.available(campaignId),
    queryFn: () => api<{ currency: string; availableMinor: string }>('GET', `/withdrawals/available/${campaignId}`),
    enabled: Boolean(campaignId),
    retry: false,
  });
}

export function useCreateWithdrawal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { campaignId: string; amountMinor: number; method: 'BANK' | 'MOBILE_MONEY'; destination: Record<string, string> }) =>
      api<Withdrawal>('POST', '/withdrawals', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY.withdrawals });
      qc.invalidateQueries({ queryKey: KEY.availableAll });
    },
  });
}

/** Requester cancels a PENDING/UNDER_REVIEW/REQUIRES_INFORMATION withdrawal. */
export function useCancelWithdrawal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`POST`, `/withdrawals/${id}/cancel`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY.withdrawals });
      qc.invalidateQueries({ queryKey: KEY.availableAll });
    },
  });
}

// ---------- fresh MFA (v1.0.4 §7) -------------------------------------------

export type MfaPurpose =
  | 'PAYOUT_FIRST_APPROVAL'
  | 'PAYOUT_SECOND_APPROVAL'
  | 'PAYOUT_SETTLEMENT'
  | 'PAYOUT_RETRY'
  | 'PAYOUT_STATE_CHANGE'
  | 'PAYOUT_RECONCILIATION'
  | 'REFUND_EXECUTION';

export interface MfaStatus {
  enrolled: boolean;
  active: boolean;
  confirmedAt: string | null;
}

export function useMfaStatus() {
  return useQuery({ queryKey: ['mfa-status'], queryFn: () => api<MfaStatus>('GET', '/mfa/status') });
}

/** Returns the otpauth:// URI + one-time displayed secret for authenticator setup. */
export function useMfaEnroll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ otpauthUri: string; secret: string; message: string }>('POST', '/mfa/enroll'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mfa-status'] }),
  });
}

export function useMfaConfirm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { code: string }) => api<{ ok: boolean; message: string }>('POST', '/mfa/confirm', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mfa-status'] }),
  });
}

/**
 * Exchanges a CURRENT TOTP code for a single-use challenge token bound to
 * (purpose, scope). The token authorizes exactly one payout operation on the
 * exact withdrawal id given as scope — a challenge for one withdrawal can
 * never authorize another.
 */
export function useMfaChallenge() {
  return useMutation({
    mutationFn: (input: { purpose: MfaPurpose; scope?: string; code: string }) =>
      api<{ challengeToken: string; expiresInSeconds: number; purpose: MfaPurpose; scope: string | null }>(
        'POST',
        '/mfa/challenge',
        input,
      ),
  });
}

// ---------- payout operations (all MFA-bound) --------------------------------

function invalidateWithdrawals(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['admin-withdrawals'] });
  qc.invalidateQueries({ queryKey: KEY.withdrawals });
  qc.invalidateQueries({ queryKey: KEY.availableAll });
}

/**
 * Mutation executor that carries the fresh-MFA challenge header. Custom hook
 * (use-prefixed) so it composes useQueryClient/useMutation legally.
 */
function useMfaMutation<TInput extends { id?: string; challenge: string }, TResult>(
  fn: (input: TInput) => { method: 'POST'; path: string; body?: unknown },
  onSuccess: (qc: ReturnType<typeof useQueryClient>) => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TInput) =>
      apiWithHeaders<TResult>(fn(input).method, fn(input).path, fn(input).body, {
        'x-mfa-challenge': input.challenge,
      }),
    onSuccess: () => onSuccess(qc),
  });
}

/** PENDING -> UNDER_REVIEW (fresh MFA). */
export function useUnderReview() {
  return useMfaMutation<{ id: string; challenge: string }, Withdrawal>(
    (i) => ({ method: 'POST', path: `/withdrawals/${i.id}/under-review` }),
    (qc) => invalidateWithdrawals(qc),
  );
}

/** PENDING/UNDER_REVIEW -> REQUIRES_INFORMATION with a required note (fresh MFA). */
export function useRequireInfo() {
  return useMfaMutation<{ id: string; note: string; challenge: string }, Withdrawal>(
    (i) => ({ method: 'POST', path: `/withdrawals/${i.id}/require-info`, body: { note: i.note } }),
    (qc) => invalidateWithdrawals(qc),
  );
}

/** FIRST APPROVAL — fresh MFA; dual approval is always required afterwards. */
export function useWithdrawalApprove() {
  return useMfaMutation<{ id: string; challenge: string }, Withdrawal & { dualApprovalRequired?: boolean; message?: string }>(
    (i) => ({ method: 'POST', path: `/withdrawals/${i.id}/approve` }),
    (qc) => {
      invalidateWithdrawals(qc);
      qc.invalidateQueries({ queryKey: KEY.adminStats });
    },
  );
}

/** SECOND APPROVAL — fresh MFA; must be a DIFFERENT administrator (server-enforced). */
export function useSecondApproval() {
  return useMfaMutation<{ id: string; note: string; challenge: string }, Withdrawal>(
    (i) => ({ method: 'POST', path: `/withdrawals/${i.id}/second-approval`, body: { note: i.note } }),
    (qc) => invalidateWithdrawals(qc),
  );
}

/** Administrative rejection of a pre-transfer payout (fresh MFA). */
export function useWithdrawalReject() {
  return useMfaMutation<{ id: string; note: string; challenge: string }, Withdrawal>(
    (i) => ({ method: 'POST', path: `/withdrawals/${i.id}/reject`, body: { note: i.note } }),
    (qc) => invalidateWithdrawals(qc),
  );
}

export interface SettlePayoutInput {
  id: string;
  payoutProvider: string;
  providerTransferRef: string;
  payoutProviderTxnId?: string;
  /** Registered PRIVATE PAYOUT_EVIDENCE StoredFile id — arbitrary URLs are rejected by the API. */
  evidenceFileId: string;
  note?: string;
  challenge: string;
}

/**
 * MANUAL SETTLEMENT (POST /withdrawals/:id/settle). Requires fresh MFA, dual
 * approval by two DISTINCT administrators (the executor cannot be the second
 * approver), a provider transfer reference and a registered evidence file.
 * The ledger posting is exactly-once (duplicate -> 409).
 */
export function useSettlePayout() {
  return useMfaMutation<SettlePayoutInput, Withdrawal>(
    (i) => ({
      method: 'POST',
      path: `/withdrawals/${i.id}/settle`,
      body: {
        payoutProvider: i.payoutProvider,
        providerTransferRef: i.providerTransferRef,
        ...(i.payoutProviderTxnId ? { payoutProviderTxnId: i.payoutProviderTxnId } : {}),
        evidenceFileId: i.evidenceFileId,
        ...(i.note ? { note: i.note } : {}),
      },
    }),
    (qc) => {
      invalidateWithdrawals(qc);
      qc.invalidateQueries({ queryKey: KEY.adminStats });
    },
  );
}

/** Safe retry (fresh MFA): only from FAILED with no unresolved attempt. */
export function useWithdrawalRetry() {
  return useMfaMutation<{ id: string; payoutProvider?: string; note?: string; challenge: string }, { id: string; attemptNo: number }>(
    (i) => ({
      method: 'POST',
      path: `/withdrawals/${i.id}/retry`,
      body: { ...(i.payoutProvider ? { payoutProvider: i.payoutProvider } : {}), ...(i.note ? { note: i.note } : {}) },
    }),
    (qc) => invalidateWithdrawals(qc),
  );
}

/** Authoritative provider verification of a payout attempt (fresh MFA). */
export function useVerifyPayoutAttempt() {
  return useMfaMutation<{ attemptId: string; challenge: string }, { attempt: { id: string; status: string; classification?: string }; applied: boolean; verification?: unknown }>(
    (i) => ({ method: 'POST', path: `/withdrawals/attempts/${i.attemptId}/verify` }),
    (qc) => invalidateWithdrawals(qc),
  );
}

/** Reconcile: attach registered evidence to a PAID payout or verify in-flight (fresh MFA). */
export function useReconcileWithdrawal() {
  return useMfaMutation<{ id: string; evidenceFileId?: string; note?: string; challenge: string }, Withdrawal>(
    (i) => ({
      method: 'POST',
      path: `/withdrawals/${i.id}/reconcile`,
      body: {
        ...(i.evidenceFileId ? { evidenceFileId: i.evidenceFileId } : {}),
        ...(i.note ? { note: i.note } : {}),
      },
    }),
    (qc) => invalidateWithdrawals(qc),
  );
}

// ---------- storage ----------

export type UploadKind = 'campaign-image' | 'document' | 'avatar' | 'payout-evidence';

/**
 * Registers an upload intent (POST /storage/uploads) and returns the presigned
 * POST policy: POST the FormData (policy fields first, then the file under
 * 'file') to postUrl, then call useConfirmUpload with the returned key.
 */
export function useRegisterUpload() {
  return useMutation({
    mutationFn: (input: { fileName: string; contentType: string; kind: UploadKind; campaignId?: string }) =>
      api<UploadRegistration>('POST', '/storage/uploads', {
        fileName: input.fileName,
        contentType: input.contentType,
        kind: input.kind,
        ...(input.campaignId ? { campaignId: input.campaignId } : {}),
      }),
  });
}

/**
 * Completes an upload (POST /storage/confirm {key}): the server verifies the
 * object's size/content type at the storage boundary and moves the file into
 * the scan lifecycle (SCANNING). Poll useMyFiles for the verdict.
 */
export function useConfirmUpload() {
  return useMutation({
    mutationFn: (key: string) => api<ConfirmUploadResponse>('POST', '/storage/confirm', { key }),
  });
}

/**
 * Registry view of the caller's own uploads (GET /storage/mine) with scan
 * status per file. Polls while any file is still being scanned.
 */
export function useMyFiles(page = 1) {
  return useQuery({
    queryKey: KEY.myFiles(page),
    queryFn: () => api<Paginated<StoredFile>>('GET', `/storage/mine?page=${page}`),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const data = query.state.data as Paginated<StoredFile> | undefined;
      const scanning = data?.items.some((f) => f.status === 'SCANNING') ?? false;
      return scanning ? 3000 : false;
    },
    refetchIntervalInBackground: false,
  });
}

// ---------- circles ----------

export function useCircles() {
  return useQuery({ queryKey: KEY.circles, queryFn: () => api<Paginated<Circle>>('GET', '/circles') });
}

export function useCircle(slug: string) {
  return useQuery({ queryKey: KEY.circle(slug), queryFn: () => api<Circle>('GET', `/circles/${slug}`), enabled: Boolean(slug) });
}

export function useCreateCircle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description?: string; privacy: 'PUBLIC' | 'PRIVATE'; goalAmountMajor?: number; currency?: string; campaignSlug?: string }) =>
      api<{ circle: Circle }>('POST', '/circles', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY.circles }),
  });
}

export function useJoinCircle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { slug: string; inviteCode?: string }) => api<{ joined: boolean }>('POST', `/circles/${input.slug}/join`, { inviteCode: input.inviteCode }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY.circles }),
  });
}

export function useCircleContribute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { slug: string; circleId: string; campaignSlug: string; amountMinor: number; kind: 'DONATION' | 'PLEDGE'; note?: string }) =>
      api<{ contribution: unknown }>('POST', `/circles/${input.slug}/contribute`, {
        circleId: input.circleId, campaignSlug: input.campaignSlug, amountMinor: input.amountMinor, kind: input.kind, note: input.note,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY.circles }),
  });
}

// ---------- organizations ----------

export function useOrganizations() {
  return useQuery({ queryKey: KEY.organizations, queryFn: () => api<Paginated<Organization>>('GET', '/organizations') });
}

export function useOrganization(slug: string) {
  return useQuery({ queryKey: KEY.organization(slug), queryFn: () => api<Organization>('GET', `/organizations/${slug}`), enabled: Boolean(slug) });
}

export function useCreateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description?: string; website?: string; country?: string; registrationNumber?: string }) =>
      api<{ organization: Organization }>('POST', '/organizations', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY.organizations }),
  });
}

// ---------- AI ----------

export function useAiStoryDraft() {
  return useMutation({
    mutationFn: (input: { title: string; category: string; targetAmountMajor?: number; country?: string; keywords?: string }) =>
      api<{ output: string; generation: AiGeneration }>('POST', '/ai/story-draft', input),
  });
}

export function useAiStoryImprove() {
  return useMutation({
    mutationFn: (input: { story: string }) => api<{ output: string; generation: AiGeneration }>('POST', '/ai/story-improve', input),
  });
}

// ---------- admin ----------

export function useAdminStats() {
  return useQuery({ queryKey: KEY.adminStats, queryFn: () => api<AdminStats>('GET', '/admin/stats') });
}

export function useAdminCampaigns(status: string) {
  return useQuery({
    queryKey: KEY.adminCampaigns(status),
    queryFn: () => api<Paginated<CampaignSummary & { approvalNote?: string }>>('GET', `/admin/campaigns?status=${status}`),
  });
}

export function useAdminCampaignAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; action: 'approve' | 'reject' | 'suspend' | 'feature' | 'unfeature'; note?: string }) =>
      api<{ campaign: CampaignSummary }>(`POST`, `/admin/campaigns/${input.id}/${input.action}`, { note: input.note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-campaigns'] });
      qc.invalidateQueries({ queryKey: KEY.adminStats });
    },
  });
}

export function useAdminUsers(page = 1) {
  return useQuery({
    queryKey: [...KEY.adminUsers, page],
    queryFn: () => api<Paginated<User>>('GET', `/admin/users?page=${page}`),
    placeholderData: keepPreviousData,
  });
}

export function useAdminUserAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; action: 'suspend' | 'activate' }) => api<{ user: User }>(`POST`, `/admin/users/${input.id}/${input.action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY.adminUsers }),
  });
}

export function useAdminWithdrawals(status: string) {
  return useQuery({
    queryKey: KEY.adminWithdrawals(status),
    queryFn: () => api<Paginated<Withdrawal>>('GET', `/withdrawals/admin/all?status=${status}`),
  });
}

export function useAdminTransactions(page = 1) {
  return useQuery({
    queryKey: KEY.adminTransactions(page),
    queryFn: () => api<Paginated<LedgerTransactionView>>('GET', `/admin/transactions?page=${page}`),
    placeholderData: keepPreviousData,
  });
}

export function useAdminRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { donationRef: string; reason: string }) => api<{ refund: unknown }>('POST', '/admin/refunds', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-transactions'] }),
  });
}

export function useAdminModeration() {
  return useQuery({ queryKey: KEY.adminModeration, queryFn: () => api<Paginated<{ id: string; entityType: string; entityId: string; reason: string; status: string; description?: string; createdAt: string }>>('GET', '/moderation/admin/cases') });
}

export function useAdminResolveModeration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; action: 'action' | 'clear'; note: string }) =>
      api<{ resolved: boolean }>(`POST`, `/moderation/admin/cases/${input.id}/resolve`, { action: input.action, note: input.note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY.adminModeration });
      qc.invalidateQueries({ queryKey: KEY.adminStats });
    },
  });
}

export function useAdminFraudSignals() {
  return useQuery({ queryKey: KEY.adminFraud, queryFn: () => api<Paginated<{ id: string; rule: string; severity: string; status: string; createdAt: string; campaign?: { title: string; slug: string } }>>('GET', '/moderation/admin/fraud-signals') });
}

export function useAdminDismissFraud() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ dismissed: boolean }>(`POST`, `/moderation/admin/fraud-signals/${id}/dismiss`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY.adminFraud });
      qc.invalidateQueries({ queryKey: KEY.adminStats });
    },
  });
}

export function useAdminReconciliation() {
  return useQuery({ queryKey: ['admin-reconciliation'], queryFn: () => api<{ lastRunAt?: string; mismatches: { reference: string; provider: string; localStatus: string; providerStatus: string }[] }>('GET', '/admin/reconciliation') });
}

export function useRunReconciliation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ started: boolean }>('POST', '/admin/reconciliation/run'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-reconciliation'] }),
  });
}

export function useReport() {
  return useMutation({
    mutationFn: (input: { entityType: string; entityId: string; description: string }) =>
      api<{ reported: boolean }>('POST', '/reports', input),
  });
}
