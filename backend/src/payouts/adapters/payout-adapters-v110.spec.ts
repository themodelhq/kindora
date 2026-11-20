import { classifyLookupHttpFailure, classifyLookupTransportFailure, lookupAmbiguous, lookupError, lookupFound, providerSubmissionReference } from '../payout-provider.adapter';
import { PaystackPayoutAdapter } from './paystack-payout.adapter';
import { FlutterwavePayoutAdapter, flwPaginationVerdictForTesting } from './flutterwave-payout.adapter';

/**
 * KINDORA v1.0.10 §3.3/§4.4/§8/§9 — provider lookup outcome contract matrix,
 * unit-tested against REALISTIC fixtures of the integrated provider API
 * versions (Flutterwave v3, Paystack 2024). fetch is mocked at the boundary.
 *
 * §8 invariant under test: only a genuine authoritative NOT_FOUND may permit
 * another submission; every uncertain outcome (contradictory pagination,
 * missing identity, transport failure, HTTP errors, malformed bodies) is
 * AMBIGUOUS or ERROR — never NOT_FOUND, never a resubmission trigger.
 */

type FetchMock = jest.SpyInstance;

type Step = { status: number; body: unknown } | { throwError: Error };

function mockFetchSequence(...steps: Step[]): { mock: FetchMock; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const mock = jest.spyOn(global, 'fetch').mockImplementation(async (url: unknown) => {
    urls.push(String(url));
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if ('throwError' in step) throw step.throwError;
    return { status: step.status, ok: step.status < 400, text: async () => JSON.stringify(step.body) } as Response;
  });
  return { mock, urls };
}

const FLW_TRANSFER_OK = {
  id: 35557,
  status: 'successful',
  reference: 'kdo-payout-wd-1-1',
  amount: 10000,
  currency: 'NGN',
  bank_code: '044',
  account_number: '0690000040',
  beneficiary_name: 'ALEX JAMES',
};

/** Flutterwave v3 paginated list envelope for a reference-filtered query. */
function flwList(content: unknown[], meta: Record<string, unknown>): unknown {
  return { status: 'success', message: 'Transfers fetched', data: { content, meta } };
}

const REF = 'kdo-payout-wd-1-1';
const OTHER_REF = 'kdo-payout-wd-2-9';

describe('v1.0.10 §3 — Flutterwave pagination validation (false NOT_FOUND closed)', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  // §3.3 table — the contradictory empty-list example from the finding.
  it('empty content with meta.total = 1 is AMBIGUOUS — never NOT_FOUND (the finding)', async () => {
    mockFetchSequence({ status: 200, body: flwList([], { pagination: { total: 1, current_page: 1, total_pages: 1, per_page: 30 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('empty content with a flat meta.total > 0 is AMBIGUOUS (alternative API revision shape)', async () => {
    mockFetchSequence({ status: 200, body: flwList([], { total: 3 }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('complete empty result with meta.total = 0 (and consistent pagination) is authoritative NOT_FOUND', async () => {
    mockFetchSequence({ status: 200, body: flwList([], { pagination: { total: 0, current_page: 1, total_pages: 1, per_page: 30 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('NOT_FOUND');
    expect(result.reason).toBe('LOOKUP_AUTHORITATIVE_NOT_FOUND');
  });

  it('complete empty result with meta.total = 0 and zero total_pages is authoritative NOT_FOUND', async () => {
    mockFetchSequence({ status: 200, body: flwList([], { pagination: { total: 0, current_page: 1, total_pages: 0, per_page: 30 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('NOT_FOUND');
  });

  // v1.0.12 §5 — CORRECTED expectation. A bare metadata-free array is no
  // longer a supported shape: it cannot be distinguished from an incomplete
  // paginated response and never classifies (AMBIGUOUS in both directions).
  it('a bare metadata-free array is AMBIGUOUS — v1.0.12 §5 removed the legacy-complete classification (never NOT_FOUND)', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', data: [] } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('empty content with contradictory page metadata (total_pages beyond an empty result) is AMBIGUOUS', async () => {
    // current_page: 2 with an empty content array implies records the page
    // set does not show — the response cannot prove absence.
    mockFetchSequence({ status: 200, body: flwList([], { pagination: { total: 0, current_page: 2, total_pages: 2, per_page: 30 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('missing pagination metadata on the paginated shape is AMBIGUOUS (required fields unexpectedly missing)', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', message: 'Transfers fetched', data: { content: [] } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('malformed pagination metadata (non-numeric total) is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: flwList([], { pagination: { total: '1', current_page: 1 } }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('malformed meta container (pagination is a string) is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', data: { content: [], meta: { pagination: 'oops' } } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('missing content field on the paginated shape is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', data: { meta: { pagination: { total: 0 } } } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('null content is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', data: { content: null, meta: { pagination: { total: 0 } } } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('unexpected response shape (data is a bare object) is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: { status: 'success', data: { unexpected: true } } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('an error envelope is never NOT_FOUND', async () => {
    mockFetchSequence({ status: 200, body: { status: 'error', message: 'No transfers available' } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('a truncated page (total > returned records) with the match present stays AMBIGUOUS — §9 contradictory pagination', async () => {
    mockFetchSequence(
      { status: 200, body: flwList([{ ...FLW_TRANSFER_OK, reference: REF }], { pagination: { total: 5, current_page: 1, total_pages: 2, per_page: 4 } }) },
      { status: 200, body: { status: 'success', data: FLW_TRANSFER_OK } },
    );
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
  });
});

describe('v1.0.10 §3.3 — Flutterwave lookup HTTP/transport matrix (§9)', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  it('HTTP 401 on the list endpoint is ERROR (credentials) — never NOT_FOUND', async () => {
    mockFetchSequence({ status: 401, body: { status: 'error', message: 'Invalid authorization token' } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('ERROR');
    expect(result.httpStatus).toBe(401);
  });

  it('HTTP 403 is ERROR — never NOT_FOUND', async () => {
    mockFetchSequence({ status: 403, body: { status: 'error', message: 'Forbidden' } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('ERROR');
  });

  it('HTTP 429 is AMBIGUOUS — never NOT_FOUND', async () => {
    mockFetchSequence({ status: 429, body: { status: 'error', message: 'Rate limit exceeded' } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.httpStatus).toBe(429);
  });

  it('HTTP 500 is AMBIGUOUS — never NOT_FOUND', async () => {
    mockFetchSequence({ status: 500, body: { status: 'error', message: 'Internal server error' } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a timeout (transport failure) is AMBIGUOUS — never NOT_FOUND', async () => {
    mockFetchSequence({ throwError: new Error('The operation was aborted due to timeout') });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.evidence).toMatchObject({ transportError: true });
  });

  it('connection reset is AMBIGUOUS', async () => {
    mockFetchSequence({ throwError: new Error('socket hang up (ECONNRESET)') });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('malformed JSON on a 200 is AMBIGUOUS — never NOT_FOUND', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => ({ status: 200, ok: true, text: async () => '<html>gateway error</html>' } as Response));
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('empty response body on a 200 is AMBIGUOUS', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => ({ status: 200, ok: true, text: async () => '' } as Response));
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('unexpected HTTP status (418) is ERROR — never guessed', async () => {
    mockFetchSequence({ status: 418, body: { status: 'error', message: "I'm a teapot" } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('ERROR');
  });

  it('HTTP 404 on the id lookup without a documented not-found body is AMBIGUOUS (v1.0.9 §2.2 rule preserved)', async () => {
    mockFetchSequence({ status: 404, body: { status: 'error', message: 'No transfer matches this id' } });
    const result = await adapter.getTransfer('35557');
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });
});

describe('v1.0.10 §4.2/§4.4 — Flutterwave exact reference identity verification', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  function okMeta(): Record<string, unknown> {
    return { pagination: { total: 1, current_page: 1, total_pages: 1, per_page: 30 } };
  }

  it('a matching list entry whose detailed record carries the EXACT reference is FOUND', async () => {
    mockFetchSequence(
      { status: 200, body: flwList([{ ...FLW_TRANSFER_OK, reference: REF }], okMeta()) },
      { status: 200, body: { status: 'success', data: FLW_TRANSFER_OK } },
    );
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('FOUND');
    expect(result.transfer?.providerTransferRef).toBe(REF);
    // The adopted reference is the authoritative record's own field.
    expect(result.transfer?.evidence?.reference).toBe(REF);
  });

  it('a list match whose detailed record carries a DIFFERENT reference is AMBIGUOUS', async () => {
    mockFetchSequence(
      { status: 200, body: flwList([{ ...FLW_TRANSFER_OK, reference: REF }], okMeta()) },
      { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, reference: OTHER_REF } } },
    );
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('FOUND');
    expect(JSON.stringify(result.evidence)).toContain('listTransferId');
  });

  it('a detailed record with a MISSING reference (id present) is AMBIGUOUS — the id never substitutes the reference', async () => {
    mockFetchSequence(
      { status: 200, body: flwList([{ ...FLW_TRANSFER_OK, reference: REF }], okMeta()) },
      { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, reference: undefined } } },
    );
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('FOUND');
  });

  it('a detailed record with a NULL reference is AMBIGUOUS', async () => {
    mockFetchSequence(
      { status: 200, body: flwList([{ ...FLW_TRANSFER_OK, reference: REF }], okMeta()) },
      { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, reference: null } } },
    );
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a detailed record with an EMPTY reference is AMBIGUOUS', async () => {
    mockFetchSequence(
      { status: 200, body: flwList([{ ...FLW_TRANSFER_OK, reference: REF }], okMeta()) },
      { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, reference: '' } } },
    );
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a list/detail ID disagreement is AMBIGUOUS (the detail does not belong to the listed transfer)', async () => {
    mockFetchSequence(
      { status: 200, body: flwList([{ ...FLW_TRANSFER_OK, reference: REF, id: 35557 }], okMeta()) },
      { status: 200, body: { status: 'success', data: { ...FLW_TRANSFER_OK, id: 99999 } } },
    );
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('multiple list entries carrying the SAME reference are AMBIGUOUS (identity unresolvable)', async () => {
    // Consistent pagination (total = 2) so the multi-match logic itself is
    // what produces the AMBIGUOUS outcome, not the pagination gate.
    mockFetchSequence({
      status: 200,
      body: flwList(
        [
          { ...FLW_TRANSFER_OK, reference: REF, id: 35557 },
          { ...FLW_TRANSFER_OK, reference: REF, id: 35558 },
        ],
        { pagination: { total: 2, current_page: 1, total_pages: 1, per_page: 30 } },
      ),
    });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(JSON.stringify(result.evidence)).toContain('matchCount');
  });

  it('a NON-empty list WITHOUT the requested reference is AMBIGUOUS (filter not honored)', async () => {
    mockFetchSequence({ status: 200, body: flwList([{ ...FLW_TRANSFER_OK, reference: OTHER_REF }], okMeta()) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('list vs detail contradiction: the detail says NOT_FOUND behind an existing list match — AMBIGUOUS, never NOT_FOUND', async () => {
    mockFetchSequence(
      { status: 200, body: flwList([{ ...FLW_TRANSFER_OK, reference: REF }], okMeta()) },
      { status: 404, body: { status: 'error', message: 'Transfer not found' } },
    );
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('a reference that differs only by case does NOT match (comparison is exact, no normalization)', async () => {
    mockFetchSequence({ status: 200, body: flwList([{ ...FLW_TRANSFER_OK, reference: 'KDO-PAYOUT-WD-1-1' }], okMeta()) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('malformed identity fields in the list entry (numeric reference) never match the requested reference', async () => {
    mockFetchSequence({ status: 200, body: flwList([{ ...FLW_TRANSFER_OK, reference: 12345 }], okMeta()) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('the stable provider reference derivation is unchanged (§4.5 — no replacement reference is ever minted)', () => {
    expect(providerSubmissionReference('payout:withdrawal-123:2')).toBe('kdo-payout-withdrawal-123-2');
  });
});

describe('v1.0.10 §4.2/§4.4 — Paystack exact reference identity verification', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.paystack.secretKey' ? 'sk_test_x' : undefined)) } as never;
  const adapter = new PaystackPayoutAdapter(config);

  afterEach(() => jest.restoreAllMocks());

  function psTransfer(overrides: Record<string, unknown>): unknown {
    return {
      status: true,
      message: 'Transfer retrieved',
      data: { id: 860703114, transfer_code: 'TRF_v5tip3zx8nna9o78', reference: REF, status: 'success', amount: 1000000, currency: 'NGN', recipient: { recipient_code: 'RCP_x', type: 'nuban', details: { account_number: '01000000010' } }, ...overrides },
    };
  }

  it('a record carrying the EXACT requested reference is FOUND', async () => {
    mockFetchSequence({ status: 200, body: psTransfer({}) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('FOUND');
    expect(result.transfer?.evidence?.reference).toBe(REF);
    expect(result.transfer?.providerTransferRef).toBe(REF);
  });

  it('a record with a DIFFERENT reference is AMBIGUOUS — never adopted', async () => {
    mockFetchSequence({ status: 200, body: psTransfer({ reference: OTHER_REF }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('FOUND');
  });

  it('a record with transfer_code + id but a MISSING reference is AMBIGUOUS (the code/id never substitute)', async () => {
    mockFetchSequence({ status: 200, body: psTransfer({ reference: undefined }) });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(JSON.stringify(result.evidence)).toContain('recordHasTransferCode');
  });

  it('a record with a NULL reference is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: psTransfer({ reference: null }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a record with an EMPTY reference is AMBIGUOUS', async () => {
    mockFetchSequence({ status: 200, body: psTransfer({ reference: '' }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a case-different reference does NOT match (exact comparison, §4.3)', async () => {
    mockFetchSequence({ status: 200, body: psTransfer({ reference: REF.toUpperCase() }) });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('the documented authoritative not-found body (404 + "Transfer not found") is NOT_FOUND', async () => {
    mockFetchSequence({ status: 404, body: { status: false, message: 'Transfer not found' } });
    const result = await adapter.findTransferByReference(REF);
    expect(result.outcome).toBe('NOT_FOUND');
    expect(result.reason).toBe('LOOKUP_AUTHORITATIVE_NOT_FOUND');
  });

  it('a 404 with an unknown payload is AMBIGUOUS — never NOT_FOUND', async () => {
    mockFetchSequence({ status: 404, body: { status: false, message: 'Unknown route' } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a 404 with a malformed body is AMBIGUOUS — never NOT_FOUND', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => ({ status: 404, ok: false, text: async () => 'not json' } as Response));
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('HTTP 401 is ERROR, 403 is ERROR — never NOT_FOUND', async () => {
    mockFetchSequence({ status: 401, body: { status: false, message: 'Invalid key' } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('ERROR');
    jest.restoreAllMocks();
    mockFetchSequence({ status: 403, body: { status: false, message: 'Forbidden' } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('ERROR');
  });

  it('HTTP 429 is AMBIGUOUS and 500 is AMBIGUOUS — never NOT_FOUND', async () => {
    mockFetchSequence({ status: 429, body: { status: false, message: 'Too many requests' } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
    jest.restoreAllMocks();
    mockFetchSequence({ status: 500, body: { status: false, message: 'Server error' } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a timeout and a connection reset are AMBIGUOUS — never NOT_FOUND', async () => {
    mockFetchSequence({ throwError: new Error('The operation was aborted due to timeout') });
    const timeout = await adapter.findTransferByReference(REF);
    expect(timeout.outcome).toBe('AMBIGUOUS');
    expect(timeout.evidence).toMatchObject({ transportError: true });
    jest.restoreAllMocks();
    mockFetchSequence({ throwError: new Error('connection reset by peer') });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('a success envelope missing expected transfer fields is AMBIGUOUS (v1.0.9 §2.2 rule preserved)', async () => {
    mockFetchSequence({ status: 200, body: { status: true, message: 'Transfer retrieved', data: { id: 1 } } });
    expect((await adapter.findTransferByReference(REF)).outcome).toBe('AMBIGUOUS');
  });

  it('getTransfer (id/code lookup) still reports FOUND for an existing transfer — verification path unchanged', async () => {
    mockFetchSequence({ status: 200, body: psTransfer({}) });
    const result = await adapter.getTransfer('860703114');
    expect(result.outcome).toBe('FOUND');
    expect(result.transfer?.providerTransferId).toBe('860703114');
  });
});

describe('v1.0.10 §8 — lookup outcome helpers keep the four-valued contract', () => {
  it('classifyLookupHttpFailure maps documented statuses exactly', () => {
    expect(classifyLookupHttpFailure('X', 401, '', {}, () => true).outcome).toBe('ERROR');
    expect(classifyLookupHttpFailure('X', 403, '', {}, () => true).outcome).toBe('ERROR');
    expect(classifyLookupHttpFailure('X', 404, '', {}, () => false).outcome).toBe('AMBIGUOUS');
    expect(classifyLookupHttpFailure('X', 404, '', {}, () => true).outcome).toBe('NOT_FOUND');
    expect(classifyLookupHttpFailure('X', 429, '', {}).outcome).toBe('AMBIGUOUS');
    expect(classifyLookupHttpFailure('X', 500, '', {}).outcome).toBe('AMBIGUOUS');
    expect(classifyLookupHttpFailure('X', 418, '', {}).outcome).toBe('ERROR');
  });

  it('classifyLookupTransportFailure is ALWAYS AMBIGUOUS', () => {
    expect(classifyLookupTransportFailure('X', new Error('boom')).outcome).toBe('AMBIGUOUS');
  });

  it('ERROR is never silently converted into NOT_FOUND by the helpers', () => {
    const err = lookupError('operational failure');
    const amb = lookupAmbiguous('uncertain');
    const found = lookupFound({
      exists: true,
      providerStatus: null,
      providerTransferRef: null,
      evidence: {},
    });
    expect(err.outcome).toBe('ERROR');
    expect(amb.outcome).toBe('AMBIGUOUS');
    expect(found.outcome).toBe('FOUND');
  });
});

describe('v1.0.10 §3 — pagination verdict unit matrix (flwPaginationVerdictForTesting)', () => {
  it('consistent zero-total metadata', () => {
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, current_page: 1, total_pages: 1, per_page: 30 } } }, 0)).toBe('CONSISTENT');
    // v1.0.12 §3.1/§3.2 — a bare result count alone NO LONGER classifies:
    // the required pagination context (current_page, total_pages) is missing
    // and a bare total cannot prove the response is complete.
    expect(flwPaginationVerdictForTesting({ meta: { total: 0 } }, 0)).toBe('INCOMPLETE');
  });

  it('contradictory totals and malformed values', () => {
    expect(flwPaginationVerdictForTesting({ meta: { total: 1 } }, 0)).toBe('INCOMPLETE');
    expect(flwPaginationVerdictForTesting({ meta: { total: 5, count: 4 } }, 0)).toBe('CONTRADICTORY');
    expect(flwPaginationVerdictForTesting({ meta: { total: '1' } }, 0)).toBe('CONTRADICTORY');
    expect(flwPaginationVerdictForTesting({ meta: { pagination: 'bad' } }, 0)).toBe('CONTRADICTORY');
  });

  it('missing required result count is INCOMPLETE — never consistent absence', () => {
    expect(flwPaginationVerdictForTesting({ meta: { current_page: 1 } }, 0)).toBe('INCOMPLETE');
    expect(flwPaginationVerdictForTesting({}, 0)).toBe('INCOMPLETE');
  });

  it('records must fit the reported pagination', () => {
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 61, current_page: 1, total_pages: 2, per_page: 30 } } }, 30)).toBe('CONTRADICTORY');
    // A truncated page (60 total, 30 returned) can never prove absence — and
    // the complete matching set cannot be resolved from it (INCOMPLETE).
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 60, current_page: 1, total_pages: 2, per_page: 30 } } }, 30)).toBe('INCOMPLETE');
    // A complete page whose result count equals the returned records is consistent.
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 2, current_page: 1, total_pages: 1, per_page: 30 } } }, 2)).toBe('CONSISTENT');
  });

  it('zero totals cannot coexist with pages beyond page 1', () => {
    // v1.0.12 §3.2 precedence — the required-field gate (total_pages missing)
    // classifies INCOMPLETE before relationship validation runs; the lookup
    // outcome is AMBIGUOUS either way (never NOT_FOUND).
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, current_page: 3 } } }, 0)).toBe('INCOMPLETE');
    // With the required field set complete, the same impossible relationship
    // classifies CONTRADICTORY.
    expect(flwPaginationVerdictForTesting({ meta: { pagination: { total: 0, current_page: 3, total_pages: 1 } } }, 0)).toBe('CONTRADICTORY');
  });
});
