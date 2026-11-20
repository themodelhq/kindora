import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exactDecimalEquals, exactDecimalStringToMinor, extractJsonNumberToken, jsonStringifyWithRawNumber, minorToExactDecimalString, MAX_TRANSMITTABLE_MINOR } from '../../common/utils/exact-money';
import { decimalsOf } from '../../common/utils/money';
import {
  canonicalHash,
  classifyLookupHttpFailure,
  classifyLookupTransportFailure,
  lookupAmbiguous,
  lookupError,
  lookupFound,
  PayoutProviderRejectedError,
  PayoutTransportError,
  PayoutProviderUnsupportedError,
  providerFetch,
  type PayoutBeneficiaryInput,
  type PayoutLookupResult,
  type PayoutProviderAdapter,
  type PayoutTransferDetails,
  type PayoutTransferInitiationInput,
  type PayoutTransferInitiationResult,
  type ResolvedBeneficiary,
} from '../payout-provider.adapter';

/**
 * Flutterwave PAYOUT adapter (v1.0.7 §3.4, v1.0.8 §6/§7, lookup hardened by
 * v1.0.9 §2) — official v3 API semantics, deliberately DIFFERENT from the
 * Paystack adapter (§3.2: no cross-provider verification logic):
 *
 *  1. Beneficiary validation: POST /v3/accounts/resolve {account_number,
 *     account_bank} resolves the authoritative account_name for BANK
 *     destinations. Flutterwave transfers take beneficiary fields INLINE
 *     (no stored recipient record).
 *     v1.0.8 §6.2 — MOBILE-MONEY destinations are validated and verified
 *     through a SEPARATE path: the provider-visible identity is the
 *     normalized (network code, mobile number, name, currency) tuple, and
 *     verification recomputes the same tuple from the TRANSFER's own fields
 *     (Flutterwave reports mobile-money transfers with account_bank = the
 *     mobile network code and account_number = the mobile number). The
 *     local hash alone is never treated as provider proof — the comparison
 *     is always provider-evidence vs approved identity.
 *  2. Transfer initiation: POST /v3/transfers {account_bank, account_number,
 *     beneficiary_name, amount (MAJOR units), narration, currency, reference,
 *     callback_url}. Response data carries {id (numeric), status ('NEW' on
 *     acceptance), reference}. v1.0.8 §7 — the amount is embedded as an
 *     EXACT decimal token (BigInt string arithmetic; no float conversion at
 *     any magnitude).
 *  3. Verification: GET /v3/transfers/:id (read-only). Flutterwave reports
 *     MAJOR units — converted to minor EXACTLY from the raw response text
 *     (no Number round-trip). If the raw amount token cannot be extracted,
 *     amountMinor is undefined -> settlement fails closed.
 *  4. Ambiguity resolution: GET /v3/transfers?reference=<ref> finds a
 *     transfer created by a lost submission.
 *  5. Status semantics: NEW|pending|queued|processing|in_progress|successful|
 *     failed|error|cancelled|reversed|reverse_initiated|reversing.
 *     v1.0.8 §8.2: reverse_initiated/reversing classify as
 *     REVERSAL_IN_PROGRESS (never terminal); anything unrecognized is UNKNOWN.
 *  6. v1.0.8 §6.3 — mobile-money payouts are DISABLED by default
 *     (PAYOUT_FLW_MOBILE_MONEY_ENABLED=false) until the verification
 *     implementation passes provider sandbox tests.
 *
 * v1.0.9 §2.2 — STRICT not-found rules. Flutterwave does NOT document an
 * authoritative not-found error body for GET /v3/transfers/:id, so a bare
 * HTTP 404 on the id lookup is AMBIGUOUS (never NOT_FOUND). The ONE
 * authoritative non-existence proof in the v3 API is the reference-filtered
 * list query: HTTP 200 + `status: "success"` + a WELL-FORMED list payload
 * (data array, or data.content array) that contains NO transfer carrying the
 * requested reference. Any error envelope, missing list shape, malformed
 * JSON, empty body or transport failure is AMBIGUOUS or ERROR — never
 * NOT_FOUND, never a resubmission.
 *
 * v1.0.11 — PAGINATION INTEGRITY & TRANSFER IDENTITY LOCKDOWN (three
 * findings closed):
 *
 *   1. STRICT PAGINATION ALIAS CONSISTENCY (§3): every supplied pagination
 *      alias in EVERY documented container (official `meta.page_info`,
 *      `data.meta.pagination`, flat `data.meta`) is validated independently
 *      as a strict in-range integer; aliases and containers representing
 *      the same property must AGREE exactly. The v1.0.10 first-value
 *      alias/cross-field selection (firstNumber) is REMOVED — conflicting
 *      aliases ({current_page: 1, page: 2}) can no longer slip through.
 *      Fractional, negative, NaN/Infinity, string, boolean, object and
 *      null values are malformed (null is SUPPLIED — never silently
 *      ignored); missing REQUIRED metadata is unverifiable (AMBIGUOUS).
 *   2. EXACT LIST-TO-DETAIL TRANSFER IDENTITY (§4): the matched list record
 *      must carry a valid transfer id, and the detailed record must carry
 *      BOTH the exact requested reference AND a valid transfer id EQUAL to
 *      the list id. A missing/null/malformed detail id is AMBIGUOUS — the
 *      v1.0.10 `detailId != null && ...` guard that let a missing id pass
 *      is REMOVED.
 *   3. METADATA-MANDATORY ADOPTION (§5): for the paginated shapes (S1
 *      official paginated array, S2 content revision), valid, complete and
 *      internally consistent pagination metadata is required before ANY
 *      classification — a matching reference inside a page without
 *      trustworthy metadata is never adopted and an empty such page is
 *      never authoritative absence. The legacy complete array (S3) keeps
 *      its own documented rules; unknown shapes are AMBIGUOUS (§5.3).
 */

const BASE = 'https://api.flutterwave.com/v3';

interface FlwEnvelope<T> {
  status?: string;
  message?: string;
  data?: T;
}

interface FlwTransfer {
  id?: number;
  status?: string;
  reference?: string;
  amount?: number;
  currency?: string;
  bank_code?: string;
  bank_name?: string;
  account_number?: string;
  beneficiary_name?: string;
  narration?: string;
}

/** Mobile-money corridors Flutterwave supports inline (no account resolve). */
const FLW_MOBILE_CURRENCIES = new Set(['GHS', 'KES', 'UGX', 'TZS', 'XOF', 'RWF', 'ZMW']);

/**
 * v1.0.8 §7 — EXACT minor->major conversion for Flutterwave payloads.
 * Kept as a named export for tests/compat: delegates to the exact utility
 * (BigInt arithmetic only — the legacy float division is REMOVED).
 */
export function flwMajorToMinorFromToken(token: string, currency: string): bigint {
  return exactDecimalStringToMinor(token, currency);
}

function normalizeAccount(v: string | null | undefined): string {
  return (v ?? '').replace(/\s+/g, '').trim();
}

/**
 * v1.0.12 §3/§4/§5 — pagination-metadata validation for the Flutterwave
 * reference-filtered list query, with STRICT alias consistency, COMPLETE
 * per-shape field requirements and JOINT outer/nested/envelope container
 * validation.
 *
 * Documented response shapes (v1.0.11 §13 provider-contract verification
 * against the official developer.flutterwave.com v3 OpenAPI description,
 * verified 2026-11 — see docs/PROVIDER_INTEGRATION_V1.0.12.md):
 *
 *   S1  OFFICIAL PAGINATED ARRAY — `data: [...]` plus an ENVELOPE-level
 *       `meta.page_info` container. v1.0.12 §3: the contract-mandated
 *       fields {total, current_page, total_pages} are ALL MANDATORY and
 *       must be valid + internally consistent before the response is used
 *       for ANY classification. A response carrying only `total: 0` no
 *       longer classifies (the v1.0.12 §3.1 finding is closed): a bare
 *       result count alone does not establish the pagination context or
 *       prove that the response is complete.
 *   S2  CONTENT REVISION — `data: { content: [...], meta... }` with the
 *       pagination metadata supplied at `data.meta` and/or nested at
 *       `data.meta.pagination` (the shape defended since v1.0.10). S2 has
 *       its OWN explicit field requirement (v1.0.12 §3.5): the same three
 *       contract-mandated fields are MANDATORY — required fields may be
 *       satisfied by ANY recognized S2 container, but every supplied
 *       container is validated and every shared field must agree across
 *       containers (v1.0.12 §4). A matching reference inside an
 *       unverifiable page is never adopted.
 *   S3  LEGACY COMPLETE ARRAY — REMOVED in v1.0.12 (§5). A metadata-free
 *       `data: [...]` array is NO LONGER treated as a complete result set:
 *       on the current paginated endpoint a bare array is
 *       byte-indistinguishable from an incomplete/truncated paginated
 *       response, and the integration has NO independently verifiable
 *       signal (no separately configured API revision, no version-specific
 *       envelope) to identify a genuinely legacy complete response. Every
 *       metadata-free array is therefore AMBIGUOUS — it can produce neither
 *       NOT_FOUND nor FOUND.
 *   S4  Anything else (unrecognized metadata structures included) —
 *       AMBIGUOUS.
 *
 * Alias groups (v1.0.11 §3.2 — every supplied value is validated
 * independently; aliases and containers representing the SAME property must
 * agree after strict normalization, or the response is contradictory):
 *
 *   total results:  total | total_count | totalCount | count
 *   current page:   current_page | page | currentPage
 *   total pages:    total_pages | pageCount | pages
 *   page size:      per_page | pageSize | page_size (OPTIONAL — v1.0.12
 *                   §3.6: never mandatory without provider-contract
 *                   justification, but validated strictly when supplied)
 *
 * Strict integer validation (v1.0.11 §3.3, v1.0.12 §3.3): a supplied value
 * must be a JSON finite number that is a safe integer within the field's
 * documented range. Fractional values, negative values, NaN/Infinity,
 * numeric strings, empty strings, booleans, objects/arrays and nulls are
 * ALL malformed. A null is a SUPPLIED value (its presence makes the response
 * ambiguous — it is never silently ignored), while an ABSENT alias
 * contributes nothing and is never invented. `current_page` is one-based
 * per the documented v3 contract (the official page_info example reports
 * `current_page: 1`, and the documented empty-result convention is
 * `current_page: 1`) — a supplied `current_page < 1` is malformed.
 */
interface FlwPaginationMeta {
  total?: unknown;
  total_count?: unknown;
  totalCount?: unknown;
  count?: unknown;
  current_page?: unknown;
  page?: unknown;
  currentPage?: unknown;
  total_pages?: unknown;
  pageCount?: unknown;
  pages?: unknown;
  per_page?: unknown;
  pageSize?: unknown;
  page_size?: unknown;
  pagination?: unknown;
}

/**
 * v1.0.12 §3.5 — the per-shape REQUIRED pagination fields, defined
 * EXPLICITLY per response shape from its verified contract (never inferred,
 * never inherited from another shape's rule).
 */
export type FlwPaginationFieldRequirement = {
  readonly total: boolean;
  readonly currentPage: boolean;
  readonly totalPages: boolean;
};

/** S1 — official v3 `meta.page_info` contract: all three fields MANDATORY (v1.0.12 §3.2). */
export const FLW_REQUIRED_S1: FlwPaginationFieldRequirement = { total: true, currentPage: true, totalPages: true };

/**
 * S2 — content-revision contract: the pagination metadata set is
 * {total, current_page, total_pages}; all three are MANDATORY for BOTH the
 * empty and the non-empty page (v1.0.12 §3.5). Defined as its OWN constant:
 * a future contract change to one shape must never silently alter the other.
 */
export const FLW_REQUIRED_S2: FlwPaginationFieldRequirement = { total: true, currentPage: true, totalPages: true };

/**
 * v1.0.12 §4.2/§4.3 — extraction of EVERY pagination container supplied on
 * an S2 content-revision response, WITHOUT discarding any of them. The
 * v1.0.11 implementation selected the nested `data.meta.pagination` object
 * and dropped the outer `data.meta` fields; the two containers may carry
 * CONTRADICTORY information (e.g. outer `total: 1` + nested `total: 0` —
 * the v1.0.12 §4.1 finding), so both are preserved and validated together.
 *
 * `data.meta` absent entirely            -> ABSENT (no container supplied).
 * `data.meta` null / array / primitive   -> MALFORMED (a SUPPLIED container
 *                                           that is not a usable object —
 *                                           never silently ignored).
 * `data.meta.pagination` null / array /
 *   primitive                             -> MALFORMED — a supplied nested
 *                                             container that is not an object
 *                                             is malformed evidence and can
 *                                             NEVER authorize fallback to the
 *                                             outer container (v1.0.12 §4.5).
 * `data.meta.pagination` {}              -> a supplied EMPTY container: it
 *                                             contributes no evidence and
 *                                             cannot contradict anything,
 *                                             but it never satisfies the
 *                                             required fields by itself.
 */
type FlwDataMetaExtraction =
  | { kind: 'ABSENT' }
  | { kind: 'MALFORMED'; reason: string }
  | { kind: 'PRESENT'; containers: FlwPaginationContainer[] };

function extractFlwListMeta(data: unknown): FlwDataMetaExtraction {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'ABSENT' };
  const raw = (data as { meta?: unknown }).meta;
  if (raw === undefined) return { kind: 'ABSENT' };
  if (raw === null) {
    return { kind: 'MALFORMED', reason: 'data.meta is null — a supplied pagination container is never silently ignored (v1.0.12 §4.5)' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'MALFORMED', reason: 'data.meta is not an object — the supplied pagination container is malformed (v1.0.12 §4.5)' };
  }
  const outer = raw as FlwPaginationMeta;
  const containers: FlwPaginationContainer[] = [['data.meta', outer]];
  const inner = outer.pagination;
  if (inner === undefined) return { kind: 'PRESENT', containers };
  if (inner === null) {
    return { kind: 'MALFORMED', reason: 'data.meta.pagination is null — a supplied nested pagination container is never silently ignored and cannot authorize fallback to the outer container (v1.0.12 §4.5)' };
  }
  if (typeof inner !== 'object' || Array.isArray(inner)) {
    return { kind: 'MALFORMED', reason: 'data.meta.pagination is not an object — the supplied nested pagination container is malformed (v1.0.12 §4.5)' };
  }
  // BOTH containers are preserved: the outer `data.meta` fields are never
  // discarded when the nested object exists (v1.0.12 §4.2).
  containers.push(['data.meta.pagination', inner as FlwPaginationMeta]);
  return { kind: 'PRESENT', containers };
}

/**
 * v1.0.11 §13 / v1.0.13 §4 — envelope-level pagination container of the
 * OFFICIAL v3 list contract (`meta.page_info`). Classification table
 * (v1.0.13 §4.2 — `undefined` and `null` are materially DIFFERENT):
 *
 * `meta === undefined`            -> ABSENT (metadata was not supplied)
 * `meta === null`                 -> MALFORMED (explicitly supplied malformed
 *                                     evidence — never silently ignored)
 * `meta` string/number/boolean/array -> MALFORMED
 * `meta` object WITHOUT `page_info` -> UNRECOGNIZED (existing contract)
 * `meta.page_info === undefined`  -> UNRECOGNIZED
 * `meta.page_info === null`       -> MALFORMED
 * `meta.page_info` primitive/array -> MALFORMED
 * `meta.page_info` valid object   -> PRESENT (subject to full pagination
 *                                     validation)
 *
 * v1.0.13 defect corrected: v1.0.12 collapsed `null` into ABSENT, so an
 * explicitly null envelope could be ignored while another container carried
 * valid fields — the exact case the strict evidence policy forbids.
 */
type FlwEnvelopeMetaExtraction =
  | { kind: 'ABSENT' }
  | { kind: 'UNRECOGNIZED' | 'MALFORMED'; reason: string }
  | { kind: 'PRESENT'; meta: FlwPaginationMeta };

function extractFlwEnvelopeMeta(body: { meta?: unknown }): FlwEnvelopeMetaExtraction {
  const raw = body.meta;
  if (raw === undefined) return { kind: 'ABSENT' };
  if (raw === null) {
    return { kind: 'MALFORMED', reason: 'envelope meta is null — explicitly supplied envelope metadata is malformed evidence and is never silently ignored (v1.0.13 §4)' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'MALFORMED', reason: 'envelope meta is not an object — the supplied envelope metadata is malformed (v1.0.13 §4)' };
  }
  const pageInfo = (raw as { page_info?: unknown }).page_info;
  if (pageInfo === undefined) {
    return { kind: 'UNRECOGNIZED', reason: 'the envelope meta object carries no page_info pagination structure (v1.0.11 §13)' };
  }
  if (pageInfo === null || typeof pageInfo !== 'object' || Array.isArray(pageInfo)) {
    return { kind: 'MALFORMED', reason: 'envelope meta.page_info is null, a primitive or an array — the supplied pagination container is malformed (v1.0.13 §4)' };
  }
  return { kind: 'PRESENT', meta: pageInfo as FlwPaginationMeta };
}

// v1.0.11 §3.2 — the documented alias groups. NO additional aliases are
// invented; each group is the union of the aliases the integration has
// defended since v1.0.10 and the fields documented in the official v3
// contract (current_page/total_pages/page_size).
const FLW_GROUP_TOTAL = ['total', 'total_count', 'totalCount', 'count'] as const;
const FLW_GROUP_CURRENT_PAGE = ['current_page', 'page', 'currentPage'] as const;
const FLW_GROUP_TOTAL_PAGES = ['total_pages', 'pageCount', 'pages'] as const;
const FLW_GROUP_PER_PAGE = ['per_page', 'pageSize', 'page_size'] as const;

/** A recognized pagination container: its provenance tag + its fields. */
type FlwPaginationContainer = readonly [tag: string, meta: FlwPaginationMeta];

/**
 * v1.0.11 §3.2/§3.3 — validate ONE alias group across EVERY container in
 * which it is supplied. Each supplied value is validated independently
 * (strict integer, in range); the group is VALID only when every supplied
 * value agrees exactly. ABSENT means no alias was supplied anywhere — it is
 * never treated as zero and never invented.
 */
type FlwAliasGroupVerdict =
  | { kind: 'ABSENT' }
  | { kind: 'VALID'; value: number }
  | { kind: 'INVALID'; supplied: string };

function validateFlwAliasGroup(
  containers: readonly FlwPaginationContainer[],
  keys: readonly (keyof FlwPaginationMeta)[],
  min: number,
): FlwAliasGroupVerdict {
  let agreed: number | undefined;
  let agreedAt: string | undefined;
  for (const [tag, meta] of containers) {
    for (const key of keys) {
      const v = (meta as Record<string, unknown>)[key as string];
      if (v === undefined) continue; // ABSENT — never invented, never zero
      const at = `${tag}.${String(key)}`;
      if (
        v === null || // supplied-as-null makes the response ambiguous
        typeof v !== 'number' || // strings/booleans/objects are malformed
        !Number.isFinite(v) || // rejects NaN and ±Infinity
        !Number.isSafeInteger(v) || // rejects fractional values and overflow
        v < min
      ) {
        return { kind: 'INVALID', supplied: `${at}=${String(v)}` };
      }
      if (agreed === undefined) {
        agreed = v;
        agreedAt = at;
      } else if (v !== agreed) {
        return { kind: 'INVALID', supplied: `${at}=${String(v)} conflicts with ${agreedAt}=${String(agreed)}` };
      }
    }
  }
  return agreed === undefined ? { kind: 'ABSENT' } : { kind: 'VALID', value: agreed };
}

/**
 * v1.0.12 §3.5 — the deterministic pagination verdict. CONSISTENT only when
 * every REQUIRED field for the response shape is present and valid, every
 * supplied field is a valid integer, every supplied container agrees on
 * shared fields, and every relevant relationship holds; INCOMPLETE when
 * required metadata is missing or the page set is truncated; CONTRADICTORY
 * on malformed values, alias/container disagreements and impossible
 * relationships. Any non-CONSISTENT verdict keeps the lookup outcome
 * AMBIGUOUS — pagination problems never upgrade to NOT_FOUND and never
 * authorize the adoption of a positive match.
 */
export type FlwPaginationDiagnosis =
  | { verdict: 'CONSISTENT' }
  | { verdict: 'INCOMPLETE'; reason: string }
  | { verdict: 'CONTRADICTORY'; reason: string };

function diagnoseFlwPagination(
  containers: readonly FlwPaginationContainer[],
  returnedCount: number,
  required: FlwPaginationFieldRequirement = FLW_REQUIRED_S2,
): FlwPaginationDiagnosis {
  // 1. EVERY supplied value is validated FIRST (v1.0.11 §3.2/§3.3) — a
  //    malformed or contradictory value classifies before missing-field
  //    checks, so a contradiction can never be concealed by an incomplete
  //    field set (the v1.0.11 first-value trap stays closed).
  const total = validateFlwAliasGroup(containers, FLW_GROUP_TOTAL, 0);
  if (total.kind === 'INVALID') return { verdict: 'CONTRADICTORY', reason: `the pagination result count is malformed or contradictory (${total.supplied})` };
  const currentPage = validateFlwAliasGroup(containers, FLW_GROUP_CURRENT_PAGE, 1); // one-based per the documented contract (v1.0.12 §3.4)
  if (currentPage.kind === 'INVALID') return { verdict: 'CONTRADICTORY', reason: `the pagination current page is malformed, below the documented one-based range, or contradictory (${currentPage.supplied})` };
  const totalPages = validateFlwAliasGroup(containers, FLW_GROUP_TOTAL_PAGES, 0);
  if (totalPages.kind === 'INVALID') return { verdict: 'CONTRADICTORY', reason: `the pagination page count is malformed or contradictory (${totalPages.supplied})` };
  const perPage = validateFlwAliasGroup(containers, FLW_GROUP_PER_PAGE, 1);
  if (perPage.kind === 'INVALID') return { verdict: 'CONTRADICTORY', reason: `the pagination page size is malformed or contradictory (${perPage.supplied})` };

  // 2. v1.0.12 §3.2/§3.5 — the REQUIRED fields for the response shape: a
  //    missing mandatory field (total / current_page / total_pages) leaves
  //    the response unverifiable. A bare result count alone (`total: 0`
  //    with no current_page and no total_pages) can no longer classify as
  //    CONSISTENT — the v1.0.12 §3.1 finding is closed.
  if (required.total && total.kind === 'ABSENT') {
    return { verdict: 'INCOMPLETE', reason: 'the pagination result count (total) is missing — completeness cannot be established without it (v1.0.12 §3.2)' };
  }
  if (required.currentPage && currentPage.kind === 'ABSENT') {
    return { verdict: 'INCOMPLETE', reason: 'the pagination current page (current_page) is missing — the required pagination context is incomplete (v1.0.12 §3.2)' };
  }
  if (required.totalPages && totalPages.kind === 'ABSENT') {
    return { verdict: 'INCOMPLETE', reason: 'the pagination page count (total_pages) is missing — the required pagination context is incomplete (v1.0.12 §3.2)' };
  }

  const totalV = total.kind === 'VALID' ? total.value : undefined;
  const perPageV = perPage.kind === 'VALID' ? perPage.value : undefined;
  const totalPagesV = totalPages.kind === 'VALID' ? totalPages.value : undefined;
  const currentPageV = currentPage.kind === 'VALID' ? currentPage.value : undefined;

  // 3. Relationship validation (v1.0.11 §3.4) — checked only between groups
  //    that are PRESENT and VALID; absent groups contribute nothing.
  if (totalV !== undefined && totalV < returnedCount) return { verdict: 'CONTRADICTORY', reason: `the metadata reports ${totalV} result(s) but the page returned ${returnedCount}` };
  if (perPageV !== undefined && returnedCount > perPageV) return { verdict: 'CONTRADICTORY', reason: `the page returned ${returnedCount} record(s), exceeding the declared page size ${perPageV}` };
  if (totalV === 0 && currentPageV !== undefined && currentPageV > 1) return { verdict: 'CONTRADICTORY', reason: `zero results cannot coexist with a current page beyond page 1 (current_page=${currentPageV})` };
  if (totalV === 0 && totalPagesV !== undefined && totalPagesV > 1) return { verdict: 'CONTRADICTORY', reason: `zero results cannot span multiple pages (total_pages=${totalPagesV})` };
  if (totalV !== undefined && totalV > 0 && totalPagesV !== undefined && totalPagesV < 1) return { verdict: 'CONTRADICTORY', reason: `nonzero results (${totalV}) cannot coexist with zero total pages` };
  // The documented empty-result convention (total=0, current_page=1,
  // total_pages=0 — the v1.0.10 verified fixture) is exempt from the
  // page-ordering relationship; any OTHER page/order disagreement stands.
  if (totalV !== undefined && totalV > 0 && currentPageV !== undefined && totalPagesV !== undefined && currentPageV > totalPagesV) return { verdict: 'CONTRADICTORY', reason: `current_page=${currentPageV} exceeds total_pages=${totalPagesV}` };
  if (totalV !== undefined && perPageV !== undefined && totalPagesV !== undefined && totalV > perPageV * totalPagesV) return { verdict: 'CONTRADICTORY', reason: `total=${totalV} exceeds the capacity of per_page=${perPageV} × total_pages=${totalPagesV}` };

  // 4. A page reporting MORE records than it returned is truncated —
  //    checked LAST so internal contradictions classify first.
  if (totalV !== undefined && totalV > returnedCount) return { verdict: 'INCOMPLETE', reason: `the provider reports ${totalV} result(s) but returned ${returnedCount} — the page set is incomplete` };

  return { verdict: 'CONSISTENT' };
}

/** Exported for the v1.0.10 §3.3 unit-test matrix. */
export function flwPaginationVerdictForTesting(data: unknown, returnedCount: number): 'CONSISTENT' | 'INCOMPLETE' | 'CONTRADICTORY' {
  const extraction = extractFlwListMeta(data);
  if (extraction.kind === 'MALFORMED') return 'CONTRADICTORY';
  if (extraction.kind === 'ABSENT') return 'INCOMPLETE';
  return diagnoseFlwPagination(extraction.containers, returnedCount, FLW_REQUIRED_S2).verdict;
}

/**
 * v1.0.12 §5.3/§6 — EXPLICIT response-shape discrimination for the
 * reference-filtered list query. Every supported shape is validated through
 * its own documented rules; an unknown structure is AMBIGUOUS — never
 * interpreted as complete, never interpreted as non-paginated. The v1.0.11
 * S3 "legacy complete array" classification is REMOVED (v1.0.12 §5): a
 * metadata-free array on the current endpoint is never authoritative
 * evidence of completeness.
 */
export type FlwListShape =
  | 'PAGINATED_ARRAY' // S1 — data array + envelope meta.page_info (official v3)
  | 'PAGINATED_CONTENT'; // S2 — data.content + data.meta (content revision)

export type FlwListShapeResult =
  | { kind: 'VALIDATED'; shape: FlwListShape; records: unknown[] }
  | { kind: 'UNSUPPORTED'; reason: string };

function classifyFlwListShape(body: FlwEnvelope<unknown> & { meta?: unknown }): FlwListShapeResult {
  const data = body.data;
  const envelopeMeta = extractFlwEnvelopeMeta(body);

  if (Array.isArray(data)) {
    if (envelopeMeta.kind === 'PRESENT') {
      // S1 — the OFFICIAL paginated array: the contract-mandated fields
      // {total, current_page, total_pages} are ALL MANDATORY (v1.0.12 §3.2).
      const diagnosis = diagnoseFlwPagination([['meta.page_info', envelopeMeta.meta]], data.length, FLW_REQUIRED_S1);
      if (diagnosis.verdict !== 'CONSISTENT') {
        return { kind: 'UNSUPPORTED', reason: `the paginated list response failed pagination validation (${diagnosis.verdict}): ${diagnosis.reason}` };
      }
      return { kind: 'VALIDATED', shape: 'PAGINATED_ARRAY', records: data };
    }
    if (envelopeMeta.kind === 'MALFORMED' || envelopeMeta.kind === 'UNRECOGNIZED') {
      const why = envelopeMeta.kind === 'MALFORMED' ? 'malformed' : 'unrecognized';
      return { kind: 'UNSUPPORTED', reason: `the list response carries an ${why} envelope-level pagination structure — the response shape cannot be verified${'reason' in envelopeMeta ? `: ${envelopeMeta.reason}` : ''}` };
    }
    // v1.0.12 §5 — a bare array with NO pagination container anywhere is no
    // longer classified as a complete legacy result (the v1.0.11 S3 rule is
    // REMOVED): on the current paginated endpoint it is byte-indistinguishable
    // from an incomplete/truncated paginated response, and this integration
    // has no independently verifiable signal (no separately configured API
    // revision, no version-specific envelope) to identify a legacy revision.
    return {
      kind: 'UNSUPPORTED',
      reason: 'the list response is a bare array with no pagination metadata — on the current paginated endpoint a metadata-free array cannot be distinguished from an incomplete response and is never treated as a complete legacy result (v1.0.12 §5)',
    };
  }

  if (data && typeof data === 'object') {
    const content = (data as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return { kind: 'UNSUPPORTED', reason: 'the list response data is an object without a content array — the response is not a documented list shape' };
    }
    // S2 — paginated content revision: metadata MANDATORY for BOTH the
    // empty and the non-empty page (v1.0.11 §5), with the S2 REQUIRED field
    // set enforced across ALL supplied containers (v1.0.12 §3.5/§4.3).
    const dataMeta = extractFlwListMeta(data);
    if (dataMeta.kind !== 'PRESENT') {
      return {
        kind: 'UNSUPPORTED',
        reason: dataMeta.kind === 'MALFORMED'
          ? `the paginated list response carries malformed pagination metadata: ${dataMeta.reason}`
          : 'the paginated list response carries NO pagination metadata — completeness cannot be established',
      };
    }
    // v1.0.12 §4.2/§4.3 — EVERY supplied container is preserved and
    // validated TOGETHER: outer `data.meta`, nested `data.meta.pagination`
    // and (when supplied) the envelope `meta.page_info`. Shared fields must
    // agree across all of them (v1.0.12 §4.4) — the nested container can
    // never silently override contradictory outer metadata.
    const containers: FlwPaginationContainer[] = [...dataMeta.containers];
    if (envelopeMeta.kind === 'PRESENT') containers.push(['meta.page_info', envelopeMeta.meta]);
    else if (envelopeMeta.kind === 'MALFORMED' || envelopeMeta.kind === 'UNRECOGNIZED') {
      const why = envelopeMeta.kind === 'MALFORMED' ? 'malformed' : 'unrecognized';
      return { kind: 'UNSUPPORTED', reason: `the list response carries an ${why} envelope-level pagination structure${'reason' in envelopeMeta ? `: ${envelopeMeta.reason}` : ''}` };
    }
    const diagnosis = diagnoseFlwPagination(containers, content.length, FLW_REQUIRED_S2);
    if (diagnosis.verdict !== 'CONSISTENT') {
      return { kind: 'UNSUPPORTED', reason: `the paginated list response failed pagination validation (${diagnosis.verdict}): ${diagnosis.reason}` };
    }
    return { kind: 'VALIDATED', shape: 'PAGINATED_CONTENT', records: content };
  }

  return { kind: 'UNSUPPORTED', reason: 'the list response data is neither an array nor a documented paginated object' };
}

/**
 * v1.0.11 §4.3 — Flutterwave transfer-id validation. The provider contract
 * represents transfer ids as positive JSON integers (the numeric `id` field
 * in the official v3 OpenAPI description). IDs are compared
 * DETERMINISTICALLY as their exact decimal strings — no truncation, no
 * prefix handling, no partial matches, no cross-type equivalence.
 */
function isFlwTransferId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/** v1.0.11 §4.2 — a merchant reference must be a non-empty string. */
function isFlwMerchantReference(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * v1.0.11 §4.2 — list record identity validation. Before ANY list result is
 * used, every record must be a well-formed transfer object: a present id
 * must be a valid provider transfer id and a present reference must be a
 * non-empty string; two records sharing one provider id must not carry
 * conflicting references. Incomplete identity records make the whole page
 * unusable (AMBIGUOUS) — they are never silently skipped.
 */
type FlwListRecordScan =
  | { kind: 'VALID'; records: FlwTransfer[] }
  | { kind: 'INVALID'; reason: string };

function scanFlwListRecords(records: unknown[]): FlwListRecordScan {
  const referenceById = new Map<string, string>();
  for (const rec of records) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      return { kind: 'INVALID', reason: 'the list contains a record that is not a transfer object' };
    }
    const t = rec as FlwTransfer;
    if (t.reference !== undefined && !isFlwMerchantReference(t.reference)) {
      return { kind: 'INVALID', reason: 'the list contains a record whose merchant reference is malformed (must be a non-empty string)' };
    }
    if (t.id !== undefined && !isFlwTransferId(t.id)) {
      return { kind: 'INVALID', reason: 'the list contains a record whose transfer id is malformed (must be a positive integer)' };
    }
    if (t.id !== undefined && t.reference !== undefined) {
      const key = String(t.id);
      const prior = referenceById.get(key);
      if (prior !== undefined && prior !== t.reference) {
        return { kind: 'INVALID', reason: 'the list contains duplicate provider transfer ids carrying conflicting merchant references' };
      }
      referenceById.set(key, t.reference);
    }
  }
  return { kind: 'VALID', records: records as FlwTransfer[] };
}

@Injectable()
export class FlutterwavePayoutAdapter implements PayoutProviderAdapter {
  readonly name = 'FLUTTERWAVE';

  constructor(private readonly config: ConfigService) {}

  supportsPayouts(): boolean {
    return true;
  }

  validatePayoutConfig(): { ok: boolean; reason?: string } {
    const key = this.config.get<string>('payments.flutterwave.secretKey');
    if (!key) return { ok: false, reason: 'FLUTTERWAVE_SECRET_KEY is not configured' };
    return { ok: true };
  }

  /**
   * v1.0.8 §6.3 — mobile-money channel gate. DISABLED by default until the
   * verification implementation is proven in the provider sandbox.
   */
  private assertMobileMoneyEnabled(): void {
    if (!this.config.get<boolean>('payouts.flwMobileMoneyEnabled')) {
      throw new PayoutProviderUnsupportedError(
        this.name,
        'mobile money payouts are DISABLED: provider-side beneficiary verification has not been sandbox-verified for this channel ' +
          '(set PAYOUT_FLW_MOBILE_MONEY_ENABLED=true only after the sandbox verification suite passes)',
      );
    }
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.config.get<string>('payments.flutterwave.secretKey')}`,
      'Content-Type': 'application/json',
    };
  }

  async resolveBeneficiary(input: PayoutBeneficiaryInput): Promise<ResolvedBeneficiary> {
    const d = input.destination;
    const accountName = (d.accountName ?? d.account_name ?? '').trim();
    const bankCode = (d.bankCode ?? d.bank_code ?? '').trim();
    const accountNumber = (d.accountNumber ?? d.account_number ?? '').trim();
    const mobileNumber = (d.mobileNumber ?? d.mobile_number ?? '').trim();
    const networkCode = (d.networkCode ?? d.network_code ?? '').trim();
    const currency = input.currency.toUpperCase();

    if (!accountName) throw new PayoutProviderRejectedError('destination is missing the beneficiary account name', this.name, 'MISSING_NAME');

    if (input.method === 'MOBILE_MONEY') {
      // v1.0.8 §6.3 — the channel is disabled unless explicitly enabled.
      this.assertMobileMoneyEnabled();
      if (!FLW_MOBILE_CURRENCIES.has(currency)) {
        throw new PayoutProviderUnsupportedError(this.name, `mobile money payouts in ${currency} are not supported by this integration`);
      }
      if (!mobileNumber) throw new PayoutProviderRejectedError('mobile money destination is missing mobileNumber', this.name, 'MISSING_MOBILE');
      const network = (networkCode || bankCode).toUpperCase();
      if (!network) {
        throw new PayoutProviderRejectedError('mobile money destination is missing the mobile network code (networkCode/bankCode)', this.name, 'MISSING_NETWORK');
      }
      // v1.0.8 §6.2 — the provider-visible mobile-money identity is the FULL
      // normalized tuple (network + number + name + currency). The hash is a
      // deterministic identity TOKEN for THIS destination; verification must
      // recompute it from the PROVIDER's own transfer fields, never from the
      // local destination JSON.
      const identity = {
        provider: this.name,
        kind: 'mobile_money',
        networkCode: network,
        mobileNumber: normalizeAccount(mobileNumber),
        accountName,
        currency,
      };
      return {
        externalRef: `flw-mm:${canonicalHash(identity)}`,
        fingerprint: canonicalHash(identity),
        maskedDetails: { kind: 'mobile_money', networkCode: network, mobileMasked: `****${mobileNumber.slice(-4)}`, accountName, currency },
        identity,
      };
    }

    if (!accountNumber || !bankCode) {
      throw new PayoutProviderRejectedError('bank destination is missing accountNumber or bankCode', this.name, 'MISSING_BANK_FIELDS');
    }

    // Authoritative account-name resolution BEFORE the transfer is ever
    // created — fail closed when the provider cannot positively resolve the
    // destination (§5.2).
    const res = await providerFetch(this.name, 'BENEFICIARY', `${BASE}/accounts/resolve`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ account_number: accountNumber, account_bank: bankCode }),
      timeoutMs: 15_000,
    });
    if (res.status >= 500) throw new PayoutTransportError(`account resolve HTTP ${res.status}`, this.name, 'BENEFICIARY');
    const body = (res.body ?? {}) as FlwEnvelope<{ account_number?: string; account_name?: string; bank_code?: string }>;
    if (!res.ok || body.status !== 'success' || !body.data) {
      // A destination the provider cannot resolve is NEVER transferred to.
      throw new PayoutProviderRejectedError(body.message ?? `account resolve HTTP ${res.status}`, this.name, 'UNRESOLVED_DESTINATION');
    }
    const resolvedName = (body.data.account_name ?? accountName).trim();
    const identity = {
      provider: this.name,
      kind: 'bank',
      bankCode,
      accountNumber: normalizeAccount(accountNumber),
      accountName: resolvedName,
      currency,
    };
    return {
      externalRef: `flw-bank:${canonicalHash(identity)}`,
      fingerprint: canonicalHash(identity),
      maskedDetails: {
        kind: 'bank',
        bankCode,
        accountNumberMasked: `****${accountNumber.slice(-4)}`,
        accountName: resolvedName,
        currency,
      },
      identity,
    };
  }

  async initiateTransfer(input: PayoutTransferInitiationInput): Promise<PayoutTransferInitiationResult> {
    const identity = input.beneficiaryIdentity;
    const accountNumber = normalizeAccount(String(identity.accountNumber ?? ''));
    const bankCode = String(identity.bankCode ?? '');
    const networkCode = String(identity.networkCode ?? '');
    const mobileNumber = normalizeAccount(String(identity.mobileNumber ?? ''));
    const accountName = String(identity.accountName ?? '');
    const currency = input.currency.toUpperCase();
    const isMobile = String(identity.kind ?? '') === 'mobile_money';

    if (input.amountMinor > MAX_TRANSMITTABLE_MINOR) {
      throw new PayoutProviderRejectedError('amount exceeds the maximum transmittable value', this.name, 'AMOUNT_OUT_OF_RANGE');
    }

    const payload: Record<string, unknown> = {
      // v1.0.8 §7 — the exact major-unit decimal (BigInt arithmetic). The
      // JSON body is serialized with the amount as a RAW token below: the
      // provider parses the exact transmitted digits, no float anywhere.
      currency,
      reference: input.providerReference,
      narration: input.narration.slice(0, 80),
    };
    if (isMobile) {
      // v1.0.8 §6.2 — v3 mobile-money transfers take the mobile network code
      // in account_bank and the mobile number in account_number.
      this.assertMobileMoneyEnabled();
      const network = (networkCode || bankCode).toUpperCase();
      if (!network || !mobileNumber) {
        throw new PayoutProviderRejectedError('mobile money beneficiary identity incomplete (network code / mobile number)', this.name, 'INCOMPLETE_MM_IDENTITY');
      }
      payload.account_bank = network;
      payload.account_number = mobileNumber;
      payload.beneficiary_name = accountName || 'KINDORA beneficiary';
    } else {
      if (!accountNumber || !bankCode || !accountName) {
        throw new PayoutProviderRejectedError('beneficiary identity incomplete for bank transfer', this.name, 'INCOMPLETE_IDENTITY');
      }
      payload.account_bank = bankCode;
      payload.account_number = accountNumber;
      payload.beneficiary_name = accountName;
    }

    const amountToken = minorToExactDecimalString(input.amountMinor, currency);
    const res = await providerFetch(this.name, 'INITIATION', `${BASE}/transfers`, {
      method: 'POST',
      headers: this.headers(),
      body: jsonStringifyWithRawNumber(payload, 'amount', amountToken),
    });

    if (res.status >= 500) throw new PayoutTransportError(`transfer HTTP ${res.status}`, this.name, 'INITIATION');
    const body = (res.body ?? {}) as FlwEnvelope<FlwTransfer>;
    if (!res.ok || body.status !== 'success' || !body.data) {
      const msg = body.message ?? `transfer HTTP ${res.status}`;
      if (/already exists|duplicate/i.test(msg)) {
        throw new PayoutTransportError(`duplicate reference: ${msg}`, this.name, 'INITIATION');
      }
      throw new PayoutProviderRejectedError(msg, this.name);
    }
    const d = body.data;
    if (d.id == null && !d.reference) {
      throw new PayoutTransportError('provider response missing transfer id and reference', this.name, 'INITIATION');
    }
    return {
      accepted: true,
      providerTransferRef: d.reference ?? input.providerReference,
      providerTransferId: d.id != null ? String(d.id) : undefined,
      providerStatus: d.status ?? undefined,
      evidence: {
        id: d.id != null ? String(d.id) : null,
        reference: d.reference ?? null,
        status: d.status ?? null,
        amount: d.amount != null ? String(d.amount) : null,
        currency: d.currency ?? null,
        message: body.message ?? null,
      },
    };
  }

  /**
   * v1.0.9 §2 — lookup with EXPLICIT four-valued outcomes. Never throws for
   * lookup failures; never maps an unsuccessful response to "not found".
   * Missing transfer fields on a success envelope are AMBIGUOUS.
   */
  async getTransfer(refOrId: string): Promise<PayoutLookupResult> {
    let res: Awaited<ReturnType<typeof providerFetch>>;
    try {
      res = await providerFetch(this.name, 'VERIFICATION', `${BASE}/transfers/${encodeURIComponent(refOrId)}`, {
        method: 'GET',
        headers: this.headers(),
      });
    } catch (err) {
      // Timeout / connection reset / DNS failure: existence NOT established.
      return classifyLookupTransportFailure(this.name, err);
    }

    if (!res.ok || res.body == null || typeof res.body !== 'object' || Array.isArray(res.body)) {
      if (res.ok && res.body == null) {
        return lookupAmbiguous('lookup returned an unparseable or empty response body — transfer existence NOT established', {
          httpStatus: res.status,
          evidence: { provider: this.name },
        });
      }
      const parsed = res.body;
      // The id-based lookup has NO documented authoritative not-found body —
      // even a 404 stays AMBIGUOUS (the strict predicate is never passed).
      return classifyLookupHttpFailure(this.name, res.status, res.bodyText, parsed);
    }

    const body = res.body as FlwEnvelope<FlwTransfer>;
    if (body.status !== 'success' || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
      return lookupAmbiguous('lookup response is not the documented success envelope — transfer existence NOT established', {
        httpStatus: res.status,
        evidence: { provider: this.name, message: typeof body.message === 'string' ? body.message.slice(0, 120) : null },
      });
    }
    const d = body.data as FlwTransfer;
    // v1.0.9 §2.2 — missing expected transfer fields -> AMBIGUOUS.
    if (d.status == null || (d.id == null && d.reference == null)) {
      return lookupAmbiguous('lookup response is missing the expected transfer fields (status/identity) — transfer existence NOT established', {
        httpStatus: res.status,
        evidence: { provider: this.name },
      });
    }

    // v1.0.8 §7 — EXACT amount conversion from the RAW response text. The
    // raw token is cross-checked against the JSON-parsed value; any mismatch
    // (or a missing token) leaves amountMinor undefined -> the settlement
    // path fails closed (PROVIDER_DATA_INCOMPLETE), never guesses.
    let amountMinor: bigint | undefined;
    if (d.amount != null && d.currency) {
      const token = extractJsonNumberToken(res.bodyText, 'amount');
      if (token && exactDecimalEquals(token, String(d.amount))) {
        try {
          amountMinor = exactDecimalStringToMinor(token, d.currency);
        } catch {
          amountMinor = undefined; // more precision than the currency supports — fail closed
        }
      }
    }

    const hasIdentity = Boolean(d.bank_code && d.account_number);
    const bankIdentity = hasIdentity
      ? {
          provider: this.name,
          kind: 'bank',
          bankCode: d.bank_code ?? '',
          accountNumber: normalizeAccount(d.account_number),
          accountName: d.beneficiary_name ?? '',
          currency: d.currency ?? '',
        }
      : undefined;
    // v1.0.8 §6.2 — mobile-money candidate identity: for transfers in a
    // mobile-money corridor, Flutterwave reports account_bank = the mobile
    // NETWORK code and account_number = the mobile number. The candidate is
    // computed from the PROVIDER's own fields (never the local destination
    // JSON); the verification service selects the candidate matching the
    // payout method — a mobile-money identifier is never treated as
    // interchangeable with a bank identifier.
    const mmIdentity =
      hasIdentity && d.currency && FLW_MOBILE_CURRENCIES.has(d.currency.toUpperCase())
        ? {
            provider: this.name,
            kind: 'mobile_money',
            networkCode: (d.bank_code ?? '').toUpperCase(),
            mobileNumber: normalizeAccount(d.account_number),
            accountName: d.beneficiary_name ?? '',
            currency: d.currency ?? '',
          }
        : undefined;
    return lookupFound({
      exists: true,
      providerStatus: d.status ?? null,
      providerTransferRef: d.reference ?? refOrId,
      providerTransferId: d.id != null ? String(d.id) : undefined,
      amountMinor,
      currency: d.currency ?? undefined,
      beneficiaryRef: bankIdentity ? `flw-bank:${canonicalHash(bankIdentity)}` : undefined,
      beneficiaryRefCandidates: mmIdentity ? { mobileMoney: `flw-mm:${canonicalHash(mmIdentity)}` } : undefined,
      beneficiaryIdentity: bankIdentity,
      failureReason: d.status === 'failed' || d.status === 'error' ? (d.narration ?? 'provider reported failure') : undefined,
      evidence: {
        id: d.id != null ? String(d.id) : null,
        reference: d.reference ?? null,
        status: d.status ?? null,
        amount: d.amount != null ? String(d.amount) : null,
        currency: d.currency ?? null,
        bankName: d.bank_name ?? null,
        accountNumberLast4: normalizeAccount(d.account_number).slice(-4),
      },
    });
  }

  /**
   * v1.0.9 §2 — ambiguity resolution by reference. HARDENED v1.0.10 §3/§4,
   * LOCKED DOWN v1.0.11 §3/§4/§5/§6 — the deterministic validation sequence:
   *
   *    1. Validate the HTTP result (transport/HTTP failures classify first).
   *    2. Validate the provider response status (success envelope only).
   *    3. Validate + classify the response shape (S1 official paginated
   *       array / S2 content revision / S4 unsupported — classifyFlwListShape;
   *       v1.0.12 §5: the v1.0.11 S3 "legacy complete array" classification
   *       is REMOVED — a metadata-free array is never verifiable evidence of
   *       a complete result set and is AMBIGUOUS in BOTH directions).
   *    4. Validate pagination metadata where the shape requires it —
   *       MANDATORY for S1/S2 (v1.0.11 §5): a page without valid, complete,
   *       internally consistent metadata can NEVER be classified — neither
   *       NOT_FOUND nor FOUND — regardless of its contents.
   *    5. An empty VALIDATED page is the ONE authoritative non-existence
   *       proof (NOT_FOUND); nothing else is.
   *    6. Validate list record identity (transfer objects only, well-formed
   *       ids and references, no duplicate provider ids with conflicting
   *       references).
   *    7. Resolve the EXACT requested-reference match (case-sensitive, no
   *       normalization); multiple matches are unresolved identity.
   *    8. The match MUST carry a valid transfer id (v1.0.11 §4.2).
   *    9. Retrieve the detailed transfer for the list-identified id.
   *   10. The detail MUST carry the EXACT requested reference (a transfer
   *       id or code never substitutes — §4.2).
   *   11. The detail MUST carry a valid transfer id (v1.0.11 §4.2 — a
   *       missing detail id can no longer pass) and it MUST equal the list
   *       transfer id.
   *   12. Return FOUND only after EVERY mandatory check has passed.
   *
   *   AMBIGUOUS/ERROR detail outcomes propagate unchanged — never collapsed
   *   into "not found". A NOT_FOUND detail behind an existing list match is
   *   a CONTRADICTION — never propagated as NOT_FOUND (that would authorize
   *   a duplicate submission while the transfer provably exists).
   */
  async findTransferByReference(reference: string): Promise<PayoutLookupResult> {
    // v1.0.10 §4.2 — the requested reference is preserved from the beginning
    // of the lookup and never replaced by a transfer id or transfer code.
    const requestedReference = reference;

    let res: Awaited<ReturnType<typeof providerFetch>>;
    try {
      res = await providerFetch(this.name, 'VERIFICATION', `${BASE}/transfers?reference=${encodeURIComponent(requestedReference)}`, {
        method: 'GET',
        headers: this.headers(),
      });
    } catch (err) {
      return classifyLookupTransportFailure(this.name, err);
    }

    // Step 1 — HTTP result validation.
    if (!res.ok || res.body == null || typeof res.body !== 'object' || Array.isArray(res.body)) {
      if (res.ok && res.body == null) {
        return lookupAmbiguous('reference lookup returned an unparseable or empty response body — transfer existence NOT established', {
          httpStatus: res.status,
          evidence: { provider: this.name },
        });
      }
      // 404 etc. on the list endpoint: Flutterwave does not document an
      // authoritative not-found shape here — AMBIGUOUS/ERROR by status rules.
      return classifyLookupHttpFailure(this.name, res.status, res.bodyText, res.body);
    }

    // Step 2 — provider response status validation.
    const body = res.body as FlwEnvelope<unknown> & { meta?: unknown };
    if (body.status !== 'success' || body.data == null) {
      return lookupAmbiguous('reference lookup response is not the documented success envelope — transfer existence NOT established', {
        httpStatus: res.status,
        evidence: { provider: this.name, message: typeof body.message === 'string' ? body.message.slice(0, 120) : null },
      });
    }

    // Steps 3-4 — shape discrimination + MANDATORY pagination gate
    // (v1.0.11 §5.2/§5.3, tightened v1.0.12 §3/§4/§5). Runs BEFORE the
    // not-found decision and BEFORE any adoption: for the paginated shapes
    // (S1/S2) the contract-mandated fields (total, current_page, total_pages)
    // must be present, valid and internally consistent across EVERY supplied
    // container, and a metadata-free array is never verifiable — missing,
    // malformed, contradictory or incomplete metadata is AMBIGUOUS even when
    // the page contains the requested reference.
    const shape = classifyFlwListShape(body);
    if (shape.kind === 'UNSUPPORTED') {
      return lookupAmbiguous(`reference lookup response shape is not verifiable: ${shape.reason} — transfer existence NOT established`, {
        httpStatus: res.status,
        evidence: { provider: this.name },
      });
    }

    // Step 5 — the ONE authoritative non-existence proof: a validated shape
    // whose complete page set contains zero records.
    if (shape.records.length === 0) {
      return { outcome: 'NOT_FOUND', reason: 'LOOKUP_AUTHORITATIVE_NOT_FOUND', httpStatus: res.status, evidence: { provider: this.name, shape: shape.shape } };
    }

    // Step 6 — list record identity validation (v1.0.11 §4.2).
    const scan = scanFlwListRecords(shape.records);
    if (scan.kind === 'INVALID') {
      return lookupAmbiguous(`reference lookup list identity could not be established: ${scan.reason} — transfer existence NOT established`, {
        httpStatus: res.status,
        evidence: { provider: this.name, listLength: shape.records.length },
      });
    }
    const list = scan.records;

    // Step 7 — EXACT reference match (case-sensitive, no normalization:
    // Flutterwave echoes the merchant reference verbatim and the comparison
    // must be deterministic — v1.0.10 §4.2/§4.3).
    const matches = list.filter((t) => t.reference === requestedReference);
    if (matches.length > 1) {
      return lookupAmbiguous('reference lookup returned multiple transfers carrying the same reference — the matching transfer identity cannot be resolved', {
        httpStatus: res.status,
        evidence: { provider: this.name, matchCount: matches.length },
      });
    }
    const match = matches[0];
    if (!match) {
      // A non-empty list WITHOUT the requested reference is anomalous (the
      // filter should be authoritative) — never treated as proof of absence.
      return lookupAmbiguous('reference lookup returned a list without the requested reference — transfer existence NOT established', {
        httpStatus: res.status,
        evidence: { provider: this.name, listLength: list.length },
      });
    }
    // Step 8 — the matched list record MUST identify its transfer
    // (v1.0.11 §4.2: the list transfer id is mandatory and must be valid).
    if (!isFlwTransferId(match.id)) {
      return lookupAmbiguous('the matching list record does not carry a valid transfer id — the list-to-detail transfer identity cannot be established', {
        httpStatus: res.status,
        evidence: { provider: this.name, listReference: typeof match.reference === 'string' ? match.reference : null },
      });
    }

    // Steps 9-12 — detailed verification of the matched transfer, against
    // BOTH the requested reference and the list-identified transfer.
    const detail = await this.getTransfer(String(match.id));
    if (detail.outcome === 'NOT_FOUND') {
      // Contradiction: the list carried the transfer, the detail says absent.
      // NEVER propagated as NOT_FOUND — that would authorize a second
      // transfer while the provider has provably seen the reference.
      return lookupAmbiguous('reference lookup found a matching transfer in the list but the detailed lookup reported it absent — contradictory provider evidence', {
        httpStatus: detail.httpStatus ?? null,
        evidence: { provider: this.name, listTransferId: String(match.id) },
      });
    }
    if (detail.outcome !== 'FOUND' || !detail.transfer) {
      // AMBIGUOUS / ERROR propagate unchanged — never collapsed.
      return detail;
    }
    // Step 10 — exact reference identity on the AUTHORITATIVE detailed
    // record: a transfer id or detail-lookup key is never a substitute for
    // the requested merchant reference (v1.0.10 §4.2).
    const detailReference = detail.transfer.evidence?.reference;
    if (typeof detailReference !== 'string' || detailReference.length === 0) {
      return lookupAmbiguous('detailed transfer record does not carry the merchant reference — the requested reference identity cannot be proven', {
        httpStatus: detail.httpStatus ?? null,
        evidence: { provider: this.name, listTransferId: String(match.id), recordHasTransferId: detail.transfer.evidence?.id != null },
      });
    }
    if (detailReference !== requestedReference) {
      return lookupAmbiguous('detailed transfer record reference differs from the requested reference — identity mismatch', {
        httpStatus: detail.httpStatus ?? null,
        evidence: { provider: this.name, listTransferId: String(match.id) },
      });
    }
    // Step 11 (v1.0.11 §4.2) — the detailed record MUST identify its own
    // transfer: a missing/null/empty/malformed detail id is AMBIGUOUS, and
    // the detail id MUST equal the list transfer id. This closes the v1.0.10
    // gap in which a detail response without an id could pass the check.
    const detailId = detail.transfer.evidence?.id;
    if (typeof detailId !== 'string' || !/^[1-9][0-9]*$/.test(detailId) || !Number.isSafeInteger(Number(detailId))) {
      return lookupAmbiguous('detailed transfer record does not carry a valid transfer id — the list-to-detail transfer identity cannot be established', {
        httpStatus: detail.httpStatus ?? null,
        evidence: { provider: this.name, listTransferId: String(match.id) },
      });
    }
    if (detailId !== String(match.id)) {
      return lookupAmbiguous('detailed transfer record does not belong to the transfer identified in the list — identity contradiction', {
        httpStatus: detail.httpStatus ?? null,
        evidence: { provider: this.name, listTransferId: String(match.id), detailTransferId: detailId },
      });
    }
    // Step 12 — every mandatory check passed.
    return detail;
  }
}
