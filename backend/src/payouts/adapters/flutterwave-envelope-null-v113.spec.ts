import { FlutterwavePayoutAdapter } from './flutterwave-payout.adapter';

/**
 * KINDORA v1.0.13 §4 — STRICT NULL HANDLING IN FLUTTERWAVE ENVELOPE METADATA
 * (unit level, deterministic fixtures; fetch is mocked at the boundary).
 *
 * The v1.0.12 defect: `extractFlwEnvelopeMeta()` treated
 * `meta === undefined` (NOT supplied) and `meta === null` (EXPLICITLY
 * supplied, malformed) as the same ABSENT case. Under the strict
 * evidence-validation policy the two are materially different: an explicit
 * `null` was SUPPLIED — it is malformed evidence and must never be silently
 * ignored while another metadata container carries valid fields.
 *
 * Exploit shape closed by this suite (the §4.3 fixture): a response with
 * `meta: null` at the envelope AND a complete, valid nested `data.meta`
 * previously classified as authoritative NOT_FOUND — an automatic
 * resubmission trigger. It must be AMBIGUOUS.
 *
 * Classification table under test (v1.0.13 §4.2):
 *   meta undefined                  -> ABSENT
 *   meta null                       -> MALFORMED
 *   meta string/number/boolean/array -> MALFORMED
 *   meta object without page_info   -> UNRECOGNIZED
 *   meta.page_info undefined        -> UNRECOGNIZED
 *   meta.page_info null             -> MALFORMED
 *   meta.page_info primitive/array  -> MALFORMED
 *   meta.page_info valid object     -> PRESENT (subject to full pagination
 *                                      validation)
 *
 * Invariants:
 *   - no malformed envelope evidence can upgrade any lookup into FOUND or
 *     NOT_FOUND (§4.3 #10);
 *   - the classification is independent of the arrangement/order of the
 *     supplied metadata containers (§4.3 #9);
 *   - the S1/S2 shape distinction and the v1.0.12 pagination contract are
 *     NOT weakened — a valid page_info object is accepted only after ALL
 *     the v1.0.12 pagination checks (§5).
 */

type Step = { status: number; body: unknown } | { status: number; rawText: string } | { throwError: Error };

function mockFetchSequence(...steps: Step[]): void {
  let i = 0;
  jest.spyOn(global, 'fetch').mockImplementation(async (url: unknown) => {
    void url;
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if ('throwError' in step) throw step.throwError;
    const text = 'rawText' in step ? step.rawText : JSON.stringify(step.body);
    return { status: step.status, ok: step.status < 400, text: async () => text } as Response;
  });
}

const REF = 'kdo-payout-wd-1-1';

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
const s2 = (content: unknown[], meta: Record<string, unknown>): unknown => ({
  status: 'success',
  message: 'Transfers fetched',
  data: { content, meta },
});

// S1 — the OFFICIAL paginated array (`data: [...]` + envelope `meta.page_info`).
const s1 = (records: unknown[], pageInfo: Record<string, unknown>): unknown => ({
  status: 'success',
  message: 'Transfers fetched',
  meta: { page_info: pageInfo },
  data: records,
});

const fullS2 = () => ({ total: 0, current_page: 1, total_pages: 1, per_page: 30 });
const fullS1 = () => ({ total: 0, current_page: 1, total_pages: 1 });

describe('v1.0.13 §4.3 — the envelope metadata classification matrix', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  // §4.3 #1 — absent envelope meta is ABSENT (never invented into a
  // container): an S1 array without envelope meta stays under the §5
  // bare-array rule, NOT under the malformed/unrecognized envelope rules.
  it('#1 an absent envelope meta field is ABSENT — the S1 array falls to the §5 bare-array rule, not to an envelope defect', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', data: [] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.reason).toContain('bare array with no pagination metadata');
    expect(result.reason).not.toContain('envelope-level pagination structure');
  });

  // §4.3 #2 — explicit null envelope meta is MALFORMED.
  it('#2 an explicitly null envelope meta is MALFORMED — never ABSENT (S1 array)', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', meta: null, data: [] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.reason).toContain('malformed');
    expect(result.reason).toContain('envelope-level pagination structure');
    expect(result.reason).toContain('envelope meta is null');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  // §4.3 #3 — a VALID envelope page_info object is accepted only after ALL
  // required pagination checks (the v1.0.12 §3 contract is not weakened).
  it('#3a a valid envelope page_info with complete consistent metadata is authoritative NOT_FOUND (empty page)', async () => {
    mockFetchSequence({ status: 200, body: s1([], fullS1()) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('NOT_FOUND');
    expect(result.outcome).not.toBe('AMBIGUOUS');
  });

  it('#3b a valid envelope page_info whose field set is INCOMPLETE never classifies (full pagination checks still apply)', async () => {
    // valid OBJECT but missing total_pages — the v1.0.12 §3.2 required set
    mockFetchSequence({ status: 200, body: s1([], { total: 0, current_page: 1 }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.reason).toContain('INCOMPLETE');
  });

  it('#3c FOUND requires the valid page_info AND the full identity chain (positive adoption)', async () => {
    const match = { ...FLW_TRANSFER_OK, id: 35557, reference: REF };
    mockFetchSequence(
      { status: 200, body: s1([match], { total: 1, current_page: 1, total_pages: 1 }) },
      { status: 200, body: { status: 'success', data: FLW_TRANSFER_OK } },
    );
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('FOUND');
    expect(result.transfer?.providerTransferRef).toBe(REF);
  });

  // §4.3 #4 — null page_info is MALFORMED.
  it('#4 a null page_info is MALFORMED (S1 array)', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', meta: { page_info: null }, data: [] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.reason).toContain('envelope meta.page_info');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('#4b a null page_info is MALFORMED on the content shape too — even with otherwise valid nested metadata', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', meta: { page_info: null }, data: { content: [], meta: fullS2() } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.reason).toContain('envelope meta.page_info');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  // §4.3 #5 — primitive page_info values are MALFORMED.
  it.each([3, 'page_info', true])('#5 a primitive page_info (%p) is MALFORMED — AMBIGUOUS', async (pi) => {
    mockFetchSequence({ status: 200, body: { status: 'success', meta: { page_info: pi }, data: [] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.reason).toContain('envelope meta.page_info');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  // §4.3 #6 — array page_info values are MALFORMED.
  it('#6 an array page_info is MALFORMED — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', meta: { page_info: [{ total: 0 }] }, data: [] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.reason).toContain('envelope meta.page_info');
  });

  // §4.3 #7 — an unrecognized envelope structure cannot authorize NOT_FOUND.
  it('#7a an envelope meta object without page_info is UNRECOGNIZED — AMBIGUOUS on the S1 array (never NOT_FOUND)', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', meta: { next: 'https://api.flutterwave.com/v3/transfers?next' }, data: [] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.reason).toContain('unrecognized envelope-level pagination structure');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('#7b an unrecognized envelope structure overrides valid nested metadata on the content shape — AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', meta: { note: 'unrecognized' }, data: { content: [], meta: fullS2() } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  // §4.3 #8 / the §4.3 FIXTURE — malformed envelope + valid nested metadata
  // stays AMBIGUOUS. This exact response previously classified as
  // authoritative NOT_FOUND (the resubmission trigger).
  it('#8 THE §4.3 FIXTURE: meta null + complete valid nested data.meta is AMBIGUOUS — never authoritative absence', async () => {
    mockFetchSequence({
      status: 200,
      body: {
        status: 'success',
        meta: null,
        data: {
          content: [],
          meta: {
            total: 0,
            current_page: 1,
            total_pages: 1,
          },
        },
      },
    });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
    expect(result.outcome).not.toBe('FOUND');
    expect(result.reason).toContain('envelope meta is null');
  });

  it('#8b the same rule on the S1 array: meta null over an array carrying the exact matching transfer is AMBIGUOUS — never FOUND', async () => {
    const match = { ...FLW_TRANSFER_OK, id: 35557, reference: REF };
    mockFetchSequence(
      { status: 200, body: { status: 'success', meta: null, data: [match] } },
      { status: 200, body: { status: 'success', data: FLW_TRANSFER_OK } },
    );
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('FOUND');
    expect(result.reason).toContain('envelope meta is null');
  });

  // §4.3 #9 — the result is unchanged when the arrangement of the supplied
  // metadata containers changes: wherever the valid evidence sits (flat
  // data.meta, nested data.meta.pagination) the null envelope forces the
  // same AMBIGUOUS outcome, and ONLY a genuinely valid envelope restores
  // the authoritative classification.
  it('#9a the null-envelope verdict is identical wherever the valid evidence sits (flat outer vs nested pagination)', async () => {
    // flat data.meta carries the complete mandate
    mockFetchSequence({ status: 200, body: { status: 'success', meta: null, data: { content: [], meta: fullS2() } } });
    const flat = await adapter.findTransferByReference(REF);
    jest.restoreAllMocks();

    // the SAME mandate split into the nested data.meta.pagination container
    mockFetchSequence({
      status: 200,
      body: {
        status: 'success',
        meta: null,
        data: { content: [], meta: { per_page: 30, pagination: { total: 0, current_page: 1, total_pages: 1 } } },
      },
    });
    const nested = await adapter.findTransferByReference(REF);
    jest.restoreAllMocks();

    expect(flat.outcome).toBe('AMBIGUOUS');
    expect(nested.outcome).toBe('AMBIGUOUS');
    expect(flat.reason).toContain('envelope meta is null');
    expect(nested.reason).toContain('envelope meta is null');
  });

  it('#9b control: ONLY the envelope evidence differs — a valid page_info with the same nested split is authoritative NOT_FOUND', async () => {
    mockFetchSequence({
      status: 200,
      body: {
        status: 'success',
        meta: { page_info: fullS1() },
        data: { content: [], meta: { per_page: 30, pagination: { total: 0, current_page: 1, total_pages: 1 } } },
      },
    });
    const result = await adapter.findTransferByReference(REF);
    // the envelope and the nested containers AGREE — the joint verdict is
    // authoritative, proving the null-envelope AMBIGUOUS was caused by the
    // malformed envelope alone
    expect(result.outcome).toBe('NOT_FOUND');
  });

  // §4.3 #10 — NO malformed envelope response can upgrade a lookup into
  // FOUND or NOT_FOUND, regardless of what the other containers carry.
  it.each([
    ['null', null],
    ['number', 0],
    ['string', 'transfers'],
    ['boolean', true],
    ['array', []],
    ['object without page_info', { revision: '2024-01' }],
    ['null page_info', { page_info: null }],
    ['primitive page_info', { page_info: 1 }],
    ['array page_info', { page_info: [] }],
  ])('#10 an envelope that is %s can never produce NOT_FOUND on an otherwise-authoritative empty page', async (_label, env) => {
    mockFetchSequence({ status: 200, body: { status: 'success', meta: env, data: { content: [], meta: fullS2() } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
    expect(result.outcome).not.toBe('FOUND');
  });

  it('#10b an envelope that is null/primitive/array can never produce FOUND on a page carrying the exact match', async () => {
    const match = { ...FLW_TRANSFER_OK, id: 35557, reference: REF };
    for (const env of [null, 'transfers', 7, true, []]) {
      jest.restoreAllMocks();
      mockFetchSequence(
        { status: 200, body: { status: 'success', meta: env, data: { content: [match], meta: { total: 1, current_page: 1, total_pages: 1, per_page: 30 } } } },
        { status: 200, body: { status: 'success', data: FLW_TRANSFER_OK } },
      );
      const result = await adapter.findTransferByReference(REF);
      expect(result.outcome).toBe('AMBIGUOUS');
      expect(result.outcome).not.toBe('FOUND');
    }
  });
});
