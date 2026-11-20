import { FlutterwavePayoutAdapter, flwPaginationVerdictForTesting } from './flutterwave-payout.adapter';

/**
 * KINDORA v1.0.12 §3/§4/§5 — PAGINATION CONTRACT COMPLETENESS & JOINT
 * CONTAINER VALIDATION test matrix (unit level, deterministic fixtures of
 * the integrated provider API revisions; fetch is mocked at the boundary).
 *
 * Invariants under test:
 *   §3   The pagination field requirements are defined EXPLICITLY per
 *        response shape from its verified contract, and the contract-mandated
 *        fields {total, current_page, total_pages} are MANDATORY on BOTH
 *        paginated shapes (S1 official page_info array, S2 content revision)
 *        before the response is used for ANY classification. The v1.0.12
 *        §3.1 finding is closed: a bare result count (total: 0 with no
 *        current_page and no total_pages) no longer classifies — a bare
 *        count alone does not establish the pagination context or prove the
 *        response is complete.
 *   §3.3/§3.4 current_page is ONE-BASED per the documented v3 contract; a
 *        supplied current_page < 1 is malformed.
 *   §3.6 page_size (per_page/pageSize/page_size) is OPTIONAL — never
 *        mandatory without provider-contract justification — but validated
 *        strictly when supplied.
 *   §4   EVERY pagination container supplied on a response is preserved and
 *        validated TOGETHER: outer `data.meta`, nested `data.meta.pagination`
 *        and (when supplied) the envelope `meta.page_info`. Shared fields
 *        must agree across all of them; the nested container can never
 *        silently override contradictory outer metadata (the v1.0.12 §4.1
 *        finding: outer total: 1 + nested total: 0). A supplied nested
 *        container that is not an object is malformed evidence and can NEVER
 *        authorize fallback to the outer container (§4.5).
 *   §5   The v1.0.11 S3 "legacy complete array" classification is REMOVED: a
 *        metadata-free `data: [...]` array on the current paginated endpoint
 *        is byte-indistinguishable from an incomplete/truncated paginated
 *        response and is AMBIGUOUS in BOTH directions — it can produce
 *        neither NOT_FOUND nor FOUND.
 *
 * Classification precedence (v1.0.12 §3.2, exercised below):
 *   1. value-level malformation / alias disagreement (CONTRADICTORY),
 *   2. the required-field gate (missing mandatory fields — INCOMPLETE),
 *   3. relationship validation between present+valid groups.
 * Every non-CONSISTENT verdict keeps the lookup outcome AMBIGUOUS — pagination
 * problems never upgrade to NOT_FOUND and never authorize adoption.
 */

type FetchMock = jest.SpyInstance;

type Step = { status: number; body: unknown } | { status: number; rawText: string } | { throwError: Error };

function mockFetchSequence(...steps: Step[]): { mock: FetchMock; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const mock = jest.spyOn(global, 'fetch').mockImplementation(async (url: unknown) => {
    urls.push(String(url));
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if ('throwError' in step) throw step.throwError;
    const text = 'rawText' in step ? step.rawText : JSON.stringify(step.body);
    return { status: step.status, ok: step.status < 400, text: async () => text } as Response;
  });
  return { mock, urls };
}

const REF = 'kdo-payout-wd-1-1';
const OTHER_REF = 'kdo-payout-wd-2-9';

const FLW_TRANSFER_OK = {
  id: 35557,
  status: 'successful',
  reference: REF,
  amount: 10000,
  currency: 'NGN',
  bank_code: '044',
  account_number: '0690000040',
  beneficiary_name: 'ALEX JAMES',
};

const detailOk = (): unknown => ({ status: 'success', message: 'Transfer fetched', data: FLW_TRANSFER_OK });

// S2 — the paginated content revision (`data.content` + `data.meta`).
const s2 = (content: unknown[], meta: Record<string, unknown>): unknown => ({ status: 'success', message: 'Transfers fetched', data: { content, meta } });

// S1 — the OFFICIAL paginated array (`data: [...]` + envelope `meta.page_info`).
const s1 = (records: unknown[], pageInfo: Record<string, unknown>): unknown => ({ status: 'success', message: 'Transfers fetched', meta: { page_info: pageInfo }, data: records });

const fullS2 = () => ({ total: 0, current_page: 1, total_pages: 1, per_page: 30 });
const fullS1 = () => ({ total: 0, current_page: 1, total_pages: 1 });

describe('v1.0.12 §3 — the per-shape mandatory field sets {total, current_page, total_pages}', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  it('S1 missing total is AMBIGUOUS — the result count is contract-mandated', async () => {
    mockFetchSequence({ status: 200, body: s1([], { current_page: 1, total_pages: 1 }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('S1 missing current_page is AMBIGUOUS — the pagination context is contract-mandated', async () => {
    mockFetchSequence({ status: 200, body: s1([], { total: 0, total_pages: 1 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('S1 missing total_pages is AMBIGUOUS — the page count is contract-mandated', async () => {
    mockFetchSequence({ status: 200, body: s1([], { total: 0, current_page: 1 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('S1 with the complete mandated set is authoritative NOT_FOUND (positive control)', async () => {
    mockFetchSequence({ status: 200, body: s1([], fullS1()) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('NOT_FOUND');
    expect(result.reason).toBe('LOOKUP_AUTHORITATIVE_NOT_FOUND');
    expect(result.evidence).toMatchObject({ shape: 'PAGINATED_ARRAY' });
  });

  it('S2 bare total: 0 (the §3.1 finding) NO LONGER classifies — AMBIGUOUS, never NOT_FOUND', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0 }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('S2 bare total: 3 (the §3.1 finding, nonzero) is AMBIGUOUS — a bare count proves nothing', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 3 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('S2 missing total_pages is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 1, per_page: 30 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('S2 missing current_page is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, total_pages: 1, per_page: 30 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('S2 missing total is AMBIGUOUS — never invented as zero', async () => {
    mockFetchSequence({ status: 200, body: s2([], { current_page: 1, total_pages: 1, per_page: 30 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('S2 with an empty pagination container is AMBIGUOUS (the container supplies no evidence)', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: {} }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('S2 with the complete mandated set and NO page_size is authoritative NOT_FOUND (page_size optional, §3.6)', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 1, total_pages: 1 }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('NOT_FOUND');
    expect(result.reason).toBe('LOOKUP_AUTHORITATIVE_NOT_FOUND');
  });

  it('S2 with the complete mandated set plus page_size is authoritative NOT_FOUND', async () => {
    mockFetchSequence({ status: 200, body: s2([], fullS2()) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('NOT_FOUND');
  });

  it('verdict helper: the required-field gate fires before relationship validation (v1.0.12 §3.2 precedence)', () => {
    // zero-total vs current_page contradiction is real, but with total_pages
    // missing the required-field gate classifies INCOMPLETE first — the
    // outcome is AMBIGUOUS either way, never NOT_FOUND.
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, current_page: 3 } } }, 0)).toBe('INCOMPLETE');
    // the same impossible relationship with the full mandated set is CONTRADICTORY
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, current_page: 3, total_pages: 1 } } }, 0)).toBe('CONTRADICTORY');
    // a bare total is INCOMPLETE on every shape's requirement set
    expect(flwPaginationVerdictForTesting({ meta: { total: 0 } }, 0)).toBe('INCOMPLETE');
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { current_page: 1 } } }, 0)).toBe('INCOMPLETE');
  });
});

describe('v1.0.12 §3.3/§3.4 — current_page is ONE-BASED per the documented contract', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  it('current_page: 0 is malformed (below the documented one-based range) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 0, total_pages: 1 }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('current_page: -1 is malformed — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s1([], { total: 0, current_page: -1, total_pages: 1 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('verdict helper: current_page 0 / -1 / 1.5 are all CONTRADICTORY', () => {
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, current_page: 0, total_pages: 1 } } }, 0)).toBe('CONTRADICTORY');
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, current_page: -1, total_pages: 1 } } }, 0)).toBe('CONTRADICTORY');
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, current_page: 1.5, total_pages: 1 } } }, 0)).toBe('CONTRADICTORY');
  });
});

describe('v1.0.12 §4 — JOINT outer/nested/envelope container validation', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  it('outer data.meta total: 1 + nested pagination total: 0 (the §4.1 finding) is AMBIGUOUS — the nested value never silently overrides', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 1, pagination: { total: 0, current_page: 1, total_pages: 1 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
    expect(result.reason).toContain("conflicts with");
  });

  it('outer and nested containers that AGREE on shared fields are authoritative NOT_FOUND', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, pagination: { total: 0, current_page: 1, total_pages: 1 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('NOT_FOUND');
  });

  it('required fields SPLIT across containers (outer total + nested context) are accepted when nothing disagrees', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, pagination: { current_page: 1, total_pages: 1 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('NOT_FOUND');
  });

  it('an empty nested pagination container contributes nothing — the outer container satisfies the mandate (positive)', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 1, total_pages: 1, pagination: {} }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('NOT_FOUND');
  });

  it('an empty nested pagination container alone satisfies nothing — AMBIGUOUS (never satisfies the required fields by itself)', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: {} }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('data.meta: null is MALFORMED evidence — never silently ignored', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', data: { content: [], meta: null } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('data.meta: "string" is MALFORMED evidence — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', data: { content: [], meta: 'oops' } } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('data.meta.pagination: null is MALFORMED — it can NEVER authorize fallback to the outer container (§4.5)', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 1, total_pages: 1, pagination: null }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
    expect(result.reason).toContain("data.meta.pagination is null");
  });

  it('data.meta.pagination: "string" is MALFORMED — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 1, total_pages: 1, pagination: 'oops' }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('data.meta.pagination as an ARRAY is MALFORMED — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 1, total_pages: 1, pagination: [] }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('THREE containers (envelope page_info + outer data.meta + nested pagination) that agree are authoritative NOT_FOUND', async () => {
    mockFetchSequence({
      status: 200,
      body: {
        status: 'success',
        message: 'Transfers fetched',
        meta: { page_info: { total: 0, current_page: 1, total_pages: 1 } },
        data: { content: [], meta: { total: 0, pagination: { total: 0, current_page: 1, total_pages: 1 } } },
      },
    });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('NOT_FOUND');
    expect(result.reason).toBe('LOOKUP_AUTHORITATIVE_NOT_FOUND');
  });

  it('THREE containers where the envelope disagrees with the content revision are AMBIGUOUS', async () => {
    mockFetchSequence({
      status: 200,
      body: {
        status: 'success',
        message: 'Transfers fetched',
        meta: { page_info: { total: 1, current_page: 1, total_pages: 1 } },
        data: { content: [], meta: { total: 0, pagination: { total: 0, current_page: 1, total_pages: 1 } } },
      },
    });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('a positive adoption still requires the FULL joint validation — FOUND only after every container agreed', async () => {
    const match = { ...FLW_TRANSFER_OK, id: 35557, reference: REF };
    mockFetchSequence(
      { status: 200, body: s2([match], { total: 1, pagination: { total: 1, current_page: 1, total_pages: 1, per_page: 30 } }) },
      { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, id: 35557, reference: REF } } },
    );
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('FOUND');
    expect(result.transfer?.providerTransferRef).toBe(REF);
    expect(result.transfer?.evidence).toMatchObject({ id: '35557', reference: REF });
  });
});

describe('v1.0.12 §4.7 — the full cross-container consistency matrix', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  it('#3 outer total 0 + nested total 1 — AMBIGUOUS (contradiction either direction)', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 1, total_pages: 1, pagination: { total: 1, current_page: 1, total_pages: 1 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('#4 outer current_page differs from nested current_page — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 1, total_pages: 1, pagination: { total: 0, current_page: 2, total_pages: 1 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('#5 outer total_pages differs from nested total_pages — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 1, total_pages: 1, pagination: { total: 0, current_page: 1, total_pages: 2 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('#6 outer and nested ALIASES disagree on the shared property (total vs total_count) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 1, total_pages: 1, pagination: { total_count: 4, current_page: 1, total_pages: 1 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.reason).toContain('conflicts with');
  });

  it('#11 pagination as an unexpected primitive (number) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 1, total_pages: 1, pagination: 7 }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('#12 the required outer container missing entirely (data.meta absent on the content shape) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', data: { content: [] } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('#13/#14 the nested container is NOT itself required: flat data.meta satisfying the mandate stays authoritative', async () => {
    // v1.0.12 §3.5 — the REQUIRED set is defined per SHAPE (S2), not per
    // container; `data.meta.pagination` is one recognized S2 container, the
    // flat `data.meta` is the other. Neither is individually mandated.
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 1, total_pages: 1 }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('NOT_FOUND');
  });

  it('#15 (regression) three containers agree — the joint verdict is authoritative', async () => {
    mockFetchSequence({
      status: 200,
      body: {
        status: 'success',
        meta: { page_info: { total: 0, current_page: 1, total_pages: 1 } },
        data: { content: [], meta: { total: 0, pagination: { total: 0, current_page: 1, total_pages: 1 } } },
      },
    });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('NOT_FOUND');
  });
});

describe('v1.0.12 §8.1 — the mandatory-field combination matrix (spec table)', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  it('missing current page AND total pages (both absent) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('positive total with missing current page — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 3, total_pages: 1 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('positive total with missing total pages — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 3, current_page: 1 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('fractional total pages on the paginated shape — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 1, total_pages: 0.5 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('current page exceeds total pages — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 4, current_page: 5, total_pages: 2 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('the documented zero-page empty convention (total 0, current_page 1, total_pages 0) stays CONSISTENT', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, current_page: 1, total_pages: 0 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('NOT_FOUND');
  });
});

describe('v1.0.12 §9 — payout recovery scenarios A-F (adapter classification; F is the retained real-PG concurrency suite)', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  it('Scenario A — recovery sees total: 0 with the required context fields missing: AMBIGUOUS (no resubmission trigger)', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0 }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
    // AMBIGUOUS preserves the reservation and blocks competing manual
    // settlement — exercised end-to-end by the real-PostgreSQL recovery suites.
  });

  it('Scenario B — recovery sees outer total 1 / nested total 0: AMBIGUOUS (no second transfer)', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 1, pagination: { total: 0, current_page: 1, total_pages: 0 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('Scenario C — recovery receives a metadata-free array from the current endpoint: AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', data: [] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('Scenario D — a valid supported response with the exact identity is FOUND and reconciles the original transfer', async () => {
    mockFetchSequence(
      { status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], { total: 1, pagination: { total: 1, current_page: 1, total_pages: 1, per_page: 30 } }) },
      { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, id: 35557 } } },
    );
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('FOUND');
    expect(result.transfer?.providerTransferRef).toBe(REF);
    expect(result.transfer?.providerTransferId).toBe('35557');
  });

  it('Scenario E — authoritative absence: complete consistent metadata without the reference is NOT_FOUND (the only resubmission precondition)', async () => {
    mockFetchSequence({ status: 200, body: s2([], { total: 0, pagination: { total: 0, current_page: 1, total_pages: 1 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('NOT_FOUND');
    expect(result.reason).toBe('LOOKUP_AUTHORITATIVE_NOT_FOUND');
  });
});

describe('v1.0.12 §5 — the legacy complete-array classification is REMOVED (AMBIGUOUS in both directions)', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  it('an empty metadata-free array is AMBIGUOUS — never NOT_FOUND (the page set is unverifiable)', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', data: [] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
    expect(result.reason).toContain("metadata-free array");
  });

  it('a metadata-free array carrying the exact matching transfer is AMBIGUOUS — never FOUND', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', data: [{ ...FLW_TRANSFER_OK }] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('FOUND');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('a non-empty metadata-free array without the requested reference is AMBIGUOUS — never NOT_FOUND', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', data: [{ ...FLW_TRANSFER_OK, reference: OTHER_REF }] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('a metadata-free array under an unrecognized envelope meta is AMBIGUOUS (the unrecognized container never rescues the shape)', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', meta: { something: 'else' }, data: [] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('the removal is not shape-specific leniency: detail-only id lookups keep their own documented rules', async () => {
    // getTransfer (id lookup) is unchanged — a documented 404 body on the
    // DETAIL endpoint still classifies per the v1.0.9 §2.2 rule.
    mockFetchSequence({ status: 404, body: { status: 'error', message: 'No transfer matches this id' } });
    const result = await adapter.getTransfer('35557');
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('regression guard: the paginated S2 shape keeps its authoritative NOT_FOUND under the tightened contract', async () => {
    mockFetchSequence({ status: 200, body: s2([], fullS2()) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('NOT_FOUND');
    expect(result.reason).toBe('LOOKUP_AUTHORITATIVE_NOT_FOUND');
    expect(result.evidence).toMatchObject({ shape: 'PAGINATED_CONTENT' });
  });

  it('regression guard: the paginated S2 shape keeps positive adoption (FOUND) under the tightened contract', async () => {
    mockFetchSequence(
      { status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], { total: 1, current_page: 1, total_pages: 1, per_page: 30 }) },
      { status: 200, body: detailOk() },
    );
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('FOUND');
    expect(result.transfer?.providerTransferId).toBe('35557');
  });
});
