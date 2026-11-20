import { FlutterwavePayoutAdapter, flwPaginationVerdictForTesting } from './flutterwave-payout.adapter';

/**
 * KINDORA v1.0.11 §9 — Flutterwave PAGINATION INTEGRITY & TRANSFER IDENTITY
 * LOCKDOWN test matrix (unit level, deterministic fixtures of the integrated
 * provider API revisions; fetch is mocked at the boundary).
 *
 * Invariants under test:
 *   §3  Every supplied pagination alias is validated; conflicting aliases,
 *       fractional/negative/malformed values and contradictory relationships
 *       are rejected — a first-value alias selection can no longer conceal a
 *       contradiction.
 *   §4  A detailed transfer is adopted ONLY with the exact requested
 *       reference AND a valid transfer id EQUAL to the list-identified id.
 *       A missing detail id can NEVER pass (the v1.0.10 gap is closed).
 *   §5  For the paginated shapes (S1 official array + meta.page_info, S2
 *       data.content), valid, complete and internally consistent metadata is
 *       MANDATORY before ANY classification — FOUND and NOT_FOUND alike.
 *   §6  The validation sequence is deterministic; FOUND is returned only
 *       after every mandatory check passed.
 *   §10 Recovery scenarios A-E classify exactly as required so the payout
 *       pipeline (AMBIGUOUS => reservation preserved, no resubmission,
 *       reconciliation-before-resubmission) behaves as specified. The full
 *       end-to-end recovery flow is exercised by the real-PostgreSQL
 *       concurrency suite (payout-lockdown / reconciliation-atomic specs).
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

// S2 — the paginated content revision (`data.content` + `data.meta`).
const okContentMeta = () => ({ pagination: { total: 1, current_page: 1, total_pages: 1, per_page: 30 } });
const s2 = (content: unknown[], meta: Record<string, unknown>): unknown => ({ status: 'success', message: 'Transfers fetched', data: { content, meta } });

// S1 — the OFFICIAL paginated array (`data: [...]` + envelope `meta.page_info`).
const s1 = (records: unknown[], pageInfo: Record<string, unknown>): unknown => ({ status: 'success', message: 'Transfers fetched', meta: { page_info: pageInfo }, data: records });

const detailOk = (): unknown => ({ status: 'success', message: 'Transfer fetched', data: FLW_TRANSFER_OK });
const matchIn = (content: unknown[]): unknown[] => content;

describe('v1.0.11 §9.1 — pagination alias consistency', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  it('one valid alias is CONSISTENT — the official page_info contract may omit page-size fields', async () => {
    mockFetchSequence({ status: 200, body: s1([], { total: 0, current_page: 1, total_pages: 1 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('NOT_FOUND');
  });

  it('two aliases carrying identical values are CONSISTENT', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 0, current_page: 1, total_pages: 1, per_page: 30, pageSize: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('NOT_FOUND');
  });

  it('current-page aliases disagree ({current_page: 1, page: 2}) — AMBIGUOUS (the §3.1 finding)', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 0, current_page: 1, page: 2, total_pages: 1, per_page: 30 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('total-page aliases disagree ({total_pages: 1, pages: 4}) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 0, current_page: 1, total_pages: 1, pages: 4, per_page: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('page-size aliases disagree ({per_page: 10, pageSize: 1}) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 0, current_page: 1, total_pages: 1, per_page: 10, pageSize: 1 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('the FULL contradictory fixture from the finding is AMBIGUOUS — never NOT_FOUND', async () => {
    const fixture = { pagination: { total: 0, current_page: 1, page: 2, total_pages: 1, pages: 4, per_page: 10, pageSize: 1 } };
    mockFetchSequence({ status: 200, body: s2([], fixture) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('total count malformed (numeric string) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: '3', current_page: 1 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a null alias is SUPPLIED and ambiguous ({current_page: 1, page: null}) — never silently ignored', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 0, current_page: 1, page: null, total_pages: 1, per_page: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a malformed string alias ("10") — AMBIGUOUS (the provider contract reports numbers)', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 0, current_page: 1, total_pages: 1, per_page: '10' } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a boolean alias (true) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 0, current_page: true } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('an object alias ({}) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 0, current_page: {} } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a fractional alias (1.5) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 1.5, current_page: 1 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a negative alias (-1) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: -1, current_page: 1 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('Infinity in the raw JSON (1e999) — AMBIGUOUS (no permissive parsing)', async () => {
    mockFetchSequence({ status: 200, rawText: '{"status":"success","message":"Transfers fetched","data":{"content":[],"meta":{"pagination":{"total":1e999,"current_page":1}}}}' });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('NaN supplied directly — AMBIGUOUS (verdict helper)', () => {
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: NaN, current_page: 1 } } }, 0)).toBe('CONTRADICTORY');
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: Infinity, current_page: 1 } } }, 0)).toBe('CONTRADICTORY');
  });

  it('official page_info container and content-revision container supplied together must AGREE — disagreement is AMBIGUOUS', async () => {
    mockFetchSequence({
      status: 200,
      body: { status: 'success', message: 'Transfers fetched', meta: { page_info: { total: 1, current_page: 1, total_pages: 1 } }, data: { content: [], meta: { pagination: { total: 0, current_page: 1, total_pages: 1 } } } },
    });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('official page_info container and content-revision container that agree are CONSISTENT', async () => {
    mockFetchSequence({
      status: 200,
      body: { status: 'success', message: 'Transfers fetched', meta: { page_info: { total: 0, current_page: 1, total_pages: 1 } }, data: { content: [], meta: { pagination: { total: 0, current_page: 1, total_pages: 1 } } } },
    });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('NOT_FOUND');
  });
});

describe('v1.0.11 §9.2 — pagination relationship validation', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  it('current page exceeds total pages — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK }], { pagination: { total: 3, current_page: 4, total_pages: 2, per_page: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('zero total pages with nonzero results — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK }], { pagination: { total: 2, current_page: 1, total_pages: 0, per_page: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('empty content with metadata claiming matching records exist on the returned page — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 1, current_page: 1, total_pages: 1, per_page: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('content count exceeds the declared page size — AMBIGUOUS (new §3.4 relationship)', async () => {
    const records = [1, 2, 3].map((n) => ({ ...FLW_TRANSFER_OK, id: 35550 + n, reference: OTHER_REF }));
    mockFetchSequence({ status: 200, body: s2(records, { pagination: { total: 3, current_page: 1, total_pages: 1, per_page: 2 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('FOUND');
  });

  it('total conflicts with the page count (total > per_page × total_pages) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 61, current_page: 1, total_pages: 2, per_page: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('zero results cannot span multiple pages (total 0, total_pages 2) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 0, current_page: 1, total_pages: 2, per_page: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('fractional page number — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 0, current_page: 1.5, total_pages: 1, per_page: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('fractional total pages — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 0, current_page: 1, total_pages: 1.5, per_page: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('negative page size — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 0, current_page: 1, total_pages: 1, per_page: -30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('missing required metadata (no total) — AMBIGUOUS, never invented as zero', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { current_page: 1, total_pages: 1, per_page: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('the documented empty-result convention (total 0, current_page 1, total_pages 0) stays authoritative NOT_FOUND', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 0, current_page: 1, total_pages: 0, per_page: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('NOT_FOUND');
  });
});

describe('v1.0.11 §9.3 — positive adoption requires complete metadata + exact identity', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  it('a complete paginated response with the exact matching transfer is FOUND (detail fetched by list id)', async () => {
    const { urls } = mockFetchSequence({ status: 200, body: s2(matchIn([{ ...FLW_TRANSFER_OK }]), okContentMeta()) }, { status: 200, body: detailOk() });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('FOUND');
    expect(result.transfer?.providerTransferRef).toBe(REF);
    expect(result.transfer?.providerTransferId).toBe('35557');
    expect(urls[1]).toContain('/transfers/35557');
  });

  it('the OFFICIAL S1 shape (data array + page_info) with the exact matching transfer is FOUND', async () => {
    mockFetchSequence({ status: 200, body: s1([{ ...FLW_TRANSFER_OK }], { total: 1, current_page: 1, total_pages: 1 }) }, { status: 200, body: detailOk() });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('FOUND');
    expect(result.transfer?.evidence?.reference).toBe(REF);
  });

  it('a complete paginated response WITHOUT the requested reference is AMBIGUOUS (filter not honored)', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, reference: OTHER_REF }], { pagination: { total: 1, current_page: 1, total_pages: 1, per_page: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a matching reference with MISSING pagination metadata is AMBIGUOUS — the §5 finding closed', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', data: { content: [{ ...FLW_TRANSFER_OK }] } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('FOUND');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('a matching reference with MALFORMED metadata is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK }], { pagination: { total: '1', current_page: 1, total_pages: 1, per_page: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a matching reference with CONTRADICTORY aliases is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK }], { pagination: { total: 1, current_page: 1, page: 3, total_pages: 1, per_page: 30 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a matching reference with an INCONSISTENT total count is AMBIGUOUS (truncated page)', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK }], { pagination: { total: 5, current_page: 1, total_pages: 2, per_page: 4 } }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a matching reference on the OFFICIAL S1 shape with contradictory page_info is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s1([{ ...FLW_TRANSFER_OK }], { total: 1, current_page: 1, page: 4, total_pages: 1 }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('an EMPTY S1 page under page_info.total > 0 is AMBIGUOUS — the top-level metadata gap v1.0.10 missed', async () => {
    mockFetchSequence({ status: 200, body: s1([], { total: 5, current_page: 1, total_pages: 1 }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('an EMPTY S1 page with page_info.total = 0 is authoritative NOT_FOUND', async () => {
    mockFetchSequence({ status: 200, body: s1([], { total: 0, current_page: 1, total_pages: 1 }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('NOT_FOUND');
    expect(result.reason).toBe('LOOKUP_AUTHORITATIVE_NOT_FOUND');
    expect(result.evidence).toMatchObject({ shape: 'PAGINATED_ARRAY' });
  });
});

describe('v1.0.11 §9.4 — explicit shape discrimination (v1.0.12 §5: NO supported non-paginated shape remains)', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  // v1.0.12 §5 — CORRECTED expectations. The v1.0.11 matrix treated a bare
  // metadata-free array as a COMPLETE legacy result (S3); v1.0.12 removes that
  // classification: on the current paginated endpoint a bare array is
  // byte-indistinguishable from an incomplete/truncated paginated response,
  // and the integration has no independently verifiable revision signal to
  // identify a genuinely legacy complete response. A metadata-free array is
  // therefore AMBIGUOUS in BOTH directions — it can produce neither NOT_FOUND
  // nor FOUND.
  it('a bare metadata-free array (empty) is NEVER authoritative NOT_FOUND — v1.0.12 §5 removed the legacy-complete classification', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', data: [] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
    expect(result.reason).toContain("metadata-free array");
  });

  it('a metadata-free array carrying the exact matching transfer is AMBIGUOUS — adoption requires verifiable pagination (v1.0.12 §5)', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', data: [{ ...FLW_TRANSFER_OK }] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('FOUND');
  });

  it('a metadata-free array without the requested reference is AMBIGUOUS (v1.0.12 §5 — the page set itself is unverifiable)', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', data: [{ ...FLW_TRANSFER_OK, reference: OTHER_REF }] } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a metadata-free array match without id is AMBIGUOUS — the shape gate and the identity gate both stand (v1.0.12 §5 + §4.5 identity rules)', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', data: [{ ...FLW_TRANSFER_OK, id: undefined }] } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('an unknown non-paginated shape (bare object) is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', data: { unexpected: true } } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('an unknown non-paginated shape (string data) is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', data: 'nope' } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('an unknown non-paginated shape (numeric data) is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', data: 42 } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('missing pagination metadata is NOT automatically interpreted as non-paginated (S1: envelope meta without page_info)', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', meta: { something: 'else' }, data: [] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('a null page_info is AMBIGUOUS — a supplied null is never silently ignored', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', meta: { page_info: null }, data: [] } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });
});

describe('v1.0.11 §4.5 — list-to-detail transfer identity matrix', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  it('#1 exact reference AND exact id — the ONLY positive outcome (FOUND)', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], okContentMeta()) }, { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, id: 35557, reference: REF } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('FOUND');
    expect(result.transfer?.evidence).toMatchObject({ id: '35557', reference: REF });
  });

  it('#2 exact reference but MISSING detail id — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], okContentMeta()) }, { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, id: undefined } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('FOUND');
  });

  it('#3 exact reference but NULL detail id — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], okContentMeta()) }, { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, id: null } } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('#4 exact reference but EMPTY detail id — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], okContentMeta()) }, { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, id: '' } } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('#5 exact reference but MALFORMED detail id — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], okContentMeta()) }, { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, id: '35x' } } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('#6 exact reference but DIFFERENT detail id — AMBIGUOUS (detail B is never adopted)', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], okContentMeta()) }, { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, id: 99999 } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.evidence).toMatchObject({ listTransferId: '35557', detailTransferId: '99999' });
  });

  it('#7 missing detail reference — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], okContentMeta()) }, { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, reference: undefined } } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('#8 different detail reference — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], okContentMeta()) }, { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, reference: OTHER_REF } } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('#9 matching id but different reference — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], okContentMeta()) }, { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, id: 35557, reference: OTHER_REF } } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('#10 different id AND different reference — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], okContentMeta()) }, { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, id: 88888, reference: OTHER_REF } } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('#11 missing list id on the matching record — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: undefined }], okContentMeta()) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('#12 missing list reference — the record cannot match; AMBIGUOUS (never absence)', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, reference: undefined }], okContentMeta()) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('#13 malformed list identity (numeric reference) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, reference: 12345 }], okContentMeta()) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('#13b malformed list identity (fractional transfer id) — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557.5 }], okContentMeta()) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('#14 detail endpoint returns no record behind an existing list match — AMBIGUOUS, never NOT_FOUND', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], okContentMeta()) }, { status: 404, body: { status: 'error', message: 'Transfer not found' } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('#15 detail endpoint returns an unexpected response structure — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], okContentMeta()) }, { status: 200, body: { status: 'success', data: 'unexpected-string' } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('#16 multiple matching-looking list records — AMBIGUOUS', async () => {
    mockFetchSequence({
      status: 200,
      body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }, { ...FLW_TRANSFER_OK, id: 35558 }], { pagination: { total: 2, current_page: 1, total_pages: 1, per_page: 30 } }),
    });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.evidence).toMatchObject({ matchCount: 2 });
  });

  it('#17 duplicate provider ids with conflicting references — AMBIGUOUS', async () => {
    mockFetchSequence({
      status: 200,
      body: s2([{ ...FLW_TRANSFER_OK, id: 35557, reference: REF }, { ...FLW_TRANSFER_OK, id: 35557, reference: OTHER_REF }], { pagination: { total: 2, current_page: 1, total_pages: 1, per_page: 30 } }),
    });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('FOUND');
    expect(JSON.stringify(result.evidence)).toContain('listLength');
  });
});

describe('v1.0.11 §10 — payout recovery scenarios A-E (adapter classification)', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  it('Scenario A — provider accepted, recovery sees an empty page with contradictory pagination aliases: AMBIGUOUS (no resubmission trigger)', async () => {
    mockFetchSequence({ status: 200, body: s2([], { pagination: { total: 0, current_page: 1, page: 3, total_pages: 1, per_page: 30 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
    // The reconciliation pipeline preserves the reservation for AMBIGUOUS —
    // exercised end-to-end by the real-PostgreSQL recovery suite.
  });

  it('Scenario B — matching reference in a valid page, detail returns the reference but NO transfer id: AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], okContentMeta()) }, { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, id: undefined } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('FOUND');
  });

  it('Scenario C — list identifies transfer A, detail returns transfer B (references match): AMBIGUOUS, B is not adopted', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557 }], okContentMeta()) }, { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, id: 44444 } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.evidence).toMatchObject({ listTransferId: '35557', detailTransferId: '44444' });
  });

  it('Scenario D — paginated content response containing the requested reference with pagination metadata MISSING: AMBIGUOUS, no adoption', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', data: { content: [{ ...FLW_TRANSFER_OK }] } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('FOUND');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('Scenario E — complete valid response: FOUND with the exact reference and the exact list id', async () => {
    mockFetchSequence({ status: 200, body: s2([{ ...FLW_TRANSFER_OK, id: 35557, reference: REF }], okContentMeta()) }, { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, id: 35557, reference: REF } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('FOUND');
    expect(result.transfer?.evidence).toMatchObject({ id: '35557', reference: REF });
    expect(result.transfer?.providerTransferRef).toBe(REF);
  });
});

describe('v1.0.11 §3.3 — strict integer validation unit matrix (verdict helper)', () => {
  it('valid integers within range stay CONSISTENT', () => {
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, current_page: 1, total_pages: 1, per_page: 30 } } }, 0)).toBe('CONSISTENT');
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 2, current_page: 1, total_pages: 1, per_page: 30 } } }, 2)).toBe('CONSISTENT');
    // page_size (the officially documented alias) is accepted
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, current_page: 1, total_pages: 1, page_size: 20 } } }, 0)).toBe('CONSISTENT');
  });

  it('fractional, negative, boolean, string, object and null values are all rejected', () => {
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0.5 } } }, 0)).toBe('CONTRADICTORY');
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: -2 } } }, 0)).toBe('CONTRADICTORY');
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: true } } }, 0)).toBe('CONTRADICTORY');
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: '2' } } }, 0)).toBe('CONTRADICTORY');
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: { n: 2 } } } }, 0)).toBe('CONTRADICTORY');
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: null, current_page: 1 } } }, 0)).toBe('CONTRADICTORY');
    // parseInt-style leniency is impossible: '10invalid' is not a number
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: '10invalid' } } }, 0)).toBe('CONTRADICTORY');
  });

  it('alias disagreements across every group are rejected (no first-value selection)', () => {
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, current_page: 1, page: 2 } } }, 0)).toBe('CONTRADICTORY');
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, total_pages: 1, pages: 4 } } }, 0)).toBe('CONTRADICTORY');
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, per_page: 10, pageSize: 1 } } }, 0)).toBe('CONTRADICTORY');
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, per_page: 10, page_size: 2 } } }, 0)).toBe('CONTRADICTORY');
    expect(flwPaginationVerdictForTesting({ meta: { total: 5, count: 4 } }, 0)).toBe('CONTRADICTORY');
  });

  it('the first-value trap is closed: a valid alias cannot conceal an invalid sibling', () => {
    // v1.0.10 firstNumber() would pick total_pages=1 and ignore pages='oops'.
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, total_pages: 1, pages: 'oops' } } }, 0)).toBe('CONTRADICTORY');
    // v1.0.10 firstNumber() would pick current_page=1 and ignore page=null.
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, current_page: 1, page: null } } }, 0)).toBe('CONTRADICTORY');
  });

  it('missing required result count is INCOMPLETE — never consistent absence', () => {
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { current_page: 1, total_pages: 1 } } }, 0)).toBe('INCOMPLETE');
    expect(flwPaginationVerdictForTesting({ meta: {} }, 0)).toBe('INCOMPLETE');
  });
});
