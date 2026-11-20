// API DTO types. Monetary amounts are strings in MINOR units (kobo/cents).

export type CampaignStatus =
  | 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'REJECTED' | 'SUSPENDED';

export type DonationStatus =
  | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'CANCELLED';

export type PaymentProvider = 'PAYSTACK' | 'FLUTTERWAVE' | 'STRIPE' | 'PAYPAL' | 'MOCK';

export type UserRole = 'USER' | 'ORG_ADMIN' | 'ADMIN';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status?: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  avatarUrl?: string | null;
  emailVerified?: boolean;
  phone?: string | null;
  country?: string | null;
  createdAt?: string;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  icon?: string | null;
}

export interface CampaignSummary {
  id: string;
  slug: string;
  title: string;
  excerpt?: string | null;
  coverImageUrl?: string | null;
  status: CampaignStatus;
  targetAmount: string;
  raisedAmount: string;
  donorCount: number;
  viewCount?: number;
  currency: string;
  deadline?: string | null;
  country?: string | null;
  isFeatured?: boolean;
  approvalNote?: string | null;
  createdAt: string;
  category?: { slug: string; name: string } | null;
  createdBy?: { firstName: string; lastName: string } | null;
  organization?: { slug: string; name: string } | null;
}

export interface CampaignDetail extends CampaignSummary {
  story: string;
  videoUrl?: string | null;
  city?: string | null;
  viewCount: number;
  allowComments: boolean;
  publishedAt?: string | null;
  beneficiary?: { name: string; type: string } | null;
  media: { id: string; url: string; type: string }[];
  matchingPools: {
    id: string;
    name: string;
    totalCommitted: string;
    matchedAmount: string;
    matchRatio: number;
    status: string;
  }[];
}

export interface Paginated<T> {
  total: number;
  items: T[];
}

export interface DonorEntry {
  publicRef: string;
  amount: string;
  currency: string;
  message?: string | null;
  matchedAmount: string;
  isAnonymous: boolean;
  donorName: string;
  createdAt: string;
}

export interface CampaignUpdate {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  author: { firstName: string; lastName: string };
}

export interface Donation {
  id?: string;
  publicRef: string;
  amount: string;
  tipAmount: string;
  currency: string;
  status: DonationStatus;
  provider?: PaymentProvider;
  message?: string | null;
  isAnonymous?: boolean;
  /** Issued by the backend only once the donation reaches SUCCEEDED. */
  receiptNumber?: string | null;
  failureReason?: string | null;
  createdAt: string;
  succeededAt?: string | null;
  campaign?: { slug: string; title: string };
  donorName?: string;
}

export interface PaymentMethod {
  provider: string;
  enabled: boolean;
}

/**
 * Withdrawal lifecycle. PENDING/UNDER_REVIEW/REQUIRES_INFORMATION are
 * cancellable by the requester; APPROVED (plus second approval above the
 * dual-approval threshold) -> PROCESSING -> PAID is the settlement path.
 * REQUIRES_RECONCILIATION is a PAID payout whose provider evidence is
 * unresolved; REVERSED undoes a settled payout (funds return to the balance).
 */
export type WithdrawalStatus =
  | 'PENDING' | 'UNDER_REVIEW' | 'REQUIRES_INFORMATION' | 'APPROVED' | 'PROCESSING'
  | 'REQUIRES_RECONCILIATION' | 'PAID' | 'REJECTED' | 'FAILED' | 'CANCELLED' | 'REVERSED';

/** Provider payout attempt (v1.0.4) — surfaced on GET /withdrawals/:id and admin rows. */
export interface PayoutAttempt {
  id: string;
  attemptNo: number;
  provider: string | null;
  status: string;
  classification?: string | null;
  providerStatus?: string | null;
  failureReason?: string | null;
  lastVerifiedAt?: string | null;
  createdAt?: string;
}

export interface Withdrawal {
  id: string;
  publicRef: string;
  amount: string;
  feeAmount: string;
  netAmount: string;
  currency: string;
  method: string;
  status: WithdrawalStatus;
  destination?: Record<string, unknown>;
  adminNote?: string | null;
  providerTransferRef?: string | null;
  payoutProvider?: string | null;
  payoutProviderTxnId?: string | null;
  evidenceUrl?: string | null;
  failureReason?: string | null;
  reviewedById?: string | null;
  secondApprovedById?: string | null;
  secondApprovedAt?: string | null;
  reconciledAt?: string | null;
  /** Latest-first provider payout attempts (v1.0.4); absent on some legacy rows. */
  payoutAttempts?: PayoutAttempt[];
  /** False for non-managers: destination fields come back masked (****last4). */
  viewerCanSeeFullDetails?: boolean;
  createdAt: string;
  paidAt?: string | null;
  campaign?: { title: string; slug: string };
}

// ---------- storage ----------

export type StoredFileKind =
  | 'CAMPAIGN_IMAGE' | 'CAMPAIGN_MEDIA' | 'AVATAR' | 'DOCUMENT' | 'IDENTITY' | 'EXPENSE_EVIDENCE';

export type StoredFileStatus = 'QUARANTINED' | 'SCANNING' | 'APPROVED' | 'REJECTED' | 'FAILED';

export type ScanVerdict = 'PENDING' | 'CLEAN' | 'INFESTED' | 'SKIPPED' | 'UNAVAILABLE';

export interface StoredFile {
  id: string;
  key: string;
  kind: StoredFileKind;
  visibility: 'PUBLIC' | 'PRIVATE';
  status: StoredFileStatus;
  scanVerdict?: ScanVerdict | null;
  fileName: string;
  contentType: string;
  /** Minor-unit style string (BigInt serialized). */
  sizeBytes: string;
  createdAt: string;
}

/** Response of POST /storage/uploads — presigned POST policy + registry record. */
export interface UploadRegistration {
  file: { id: string; key: string; kind: string; visibility: 'PUBLIC' | 'PRIVATE'; status: string };
  postUrl: string;
  /** Presigned POST form fields; append the file under the 'file' field AFTER these. */
  fields: Record<string, string>;
  /** Legacy alias of postUrl, kept for backwards-compatible clients. */
  uploadUrl?: string;
  /** Present only for PUBLIC kinds — private files are reached via signed GETs. */
  publicUrl?: string;
  key: string;
  expiresIn: number;
  maxBytes: number;
}

export interface ConfirmUploadResponse {
  status: 'SCANNING';
  fileId: string;
  key: string;
}

export interface Circle {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  privacy: 'PUBLIC' | 'PRIVATE';
  inviteCode?: string | null;
  goalAmount?: string | null;
  currency: string;
  createdAt: string;
  members?: { user: User; role: string }[];
  contributions?: { id: string; amount: string; kind: string; note?: string | null; createdAt?: string; user: User }[];
}

export interface Organization {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  website?: string | null;
  country?: string | null;
  status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';
  campaigns?: CampaignSummary[];
  members?: { user: User; role: string }[];
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt?: string | null;
  createdAt: string;
}

export interface ImpactSummary {
  totalDonations: number;
  totalRefunded: number;
  totalTipsMinor: string;
  ledger: { ledgerAccounts: number; ledgerTransactions: number; successfulDonations: number };
  recentDaily: { date: string; donationCount: number; donationAmount: string; currency: string }[];
}

export interface LedgerTransactionView {
  id: string;
  reference: string;
  type: string;
  description?: string | null;
  postedAt: string;
  entries: { direction: 'DEBIT' | 'CREDIT'; amount: string; currency: string }[];
}

export interface AiGeneration {
  id: string;
  kind: string;
  output: string;
  createdAt: string;
}

export interface AdminStats {
  users: number;
  campaigns: number;
  campaignsPending: number;
  donationsTotalMinor: string;
  donationsCount: number;
  withdrawalsPending: number;
  moderationOpen: number;
  fraudOpen: number;
}
