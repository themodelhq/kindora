import { PaystackPayoutAdapter } from './paystack-payout.adapter';
import { FlutterwavePayoutAdapter } from './flutterwave-payout.adapter';

/**
 * v1.0.9 §2.2/§12.1 — provider lookup classification matrix.
 *
 * fetch is mocked at the HTTP boundary (same discipline as payout-adapters.spec).
 * The matrix proves the P0 fix: an unsuccessful provider lookup NEVER becomes
 * NOT_FOUND — 401/403/429/5xx/timeout/reset/malformed/empty/missing-fields all
 * classify AMBIGUOUS or ERROR, and only the DOCUMENTED authoritative not-found
 * response shape yields NOT_FOUND. Nothing in this matrix may ever throw.
 */

type FetchMock = jest.SpyInstance;

function mockFetch(status: number, body: unknown | string): FetchMock {
  return jest.spyOn(global, 'fetch').mockImplementation(async () => {
    const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
    return { status, ok: status < 400, text: async () => bodyText } as Response;
  });
}

function mockTransportFailure(err: Error): FetchMock {
  return jest.spyOn(global, 'fetch').mockImplementation(async () => {
    throw err;
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

const paystackConfig = { get: jest.fn((k: string) => (k === 'payments.paystack.secretKey' ? 'sk_test_x' : undefined)) } as never;
const flwConfig = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_test_x' : undefined)) } as never;

describe('Paystack lookup classification (v1.0.9 §12.1)', () => {
  const adapter = new PaystackPayoutAdapter(paystackConfig);
  const ref = 'kdo-payout-wd-1-1';

  it('a valid existing transfer classifies FOUND with provider evidence', async () => {
    mockFetch(200, {
      status: true,
      data: { id: 860703114, transfer_code: 'TRF_x', reference: ref, status: 'success', amount: 1000000, currency: 'NGN', recipient: { recipient_code: 'RCP_1', details: {} } },
    });
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('FOUND');
    expect(result.transfer?.amountMinor).toBe(1_000_000n);
    expect(result.transfer?.beneficiaryRef).toBe('RCP_1');
  });

  it('the documented not-found response ({status:false, message:"Transfer not found"} + HTTP 404) classifies NOT_FOUND', async () => {
    mockFetch(404, { status: false, message: 'Transfer not found' });
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('NOT_FOUND');
  });

  it('a bare 404 with a non-documented body is NOT authoritative — AMBIGUOUS', async () => {
    mockFetch(404, { status: false, message: 'Not found' });
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('a 404 with extra data is NOT authoritative — AMBIGUOUS', async () => {
    mockFetch(404, { status: false, message: 'Transfer not found', data: { id: 1 } });
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  const cases: Array<[string, number, unknown]> = [
    ['HTTP 401', 401, { status: false, message: 'Unauthorized' }],
    ['HTTP 403', 403, { status: false, message: 'Forbidden' }],
    ['HTTP 429', 429, { status: false, message: 'Too many requests' }],
    ['HTTP 500', 500, { status: 'error', message: 'server error' }],
    ['HTTP 503', 503, 'service unavailable'],
    ['unknown provider error (HTTP 400)', 400, { status: false, message: 'weird unknown code' }],
  ];
  for (const [name, status, body] of cases) {
    it(`${name} never proves non-existence (AMBIGUOUS/ERROR)`, async () => {
      mockFetch(status, body);
      const result = await adapter.getTransfer(ref);
      expect(['AMBIGUOUS', 'ERROR']).toContain(result.outcome);
      expect(result.outcome).not.toBe('NOT_FOUND');
    });
  }

  it('a timeout classifies AMBIGUOUS and never throws', async () => {
    mockTransportFailure(new Error('The operation was aborted due to timeout'));
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.reason).toContain('transport');
  });

  it('a connection reset classifies AMBIGUOUS', async () => {
    mockTransportFailure(new Error('socket hang up (ECONNRESET)'));
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('a DNS failure classifies AMBIGUOUS', async () => {
    mockTransportFailure(new Error('getaddrinfo ENOTFOUND api.paystack.co'));
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('malformed JSON classifies AMBIGUOUS', async () => {
    mockFetch(200, '<html>not json</html>');
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('an empty response body classifies AMBIGUOUS', async () => {
    mockFetch(200, '');
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('missing transfer fields on a success envelope classify AMBIGUOUS', async () => {
    mockFetch(200, { status: true, data: { amount: 1000000 } });
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('a success envelope without data classifies AMBIGUOUS (never exists=false)', async () => {
    mockFetch(200, { status: true, message: 'ok' });
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('findTransferByReference inherits the strict classification', async () => {
    mockFetch(404, { status: false, message: 'Transfer not found' });
    expect((await adapter.findTransferByReference(ref)).outcome).toBe('NOT_FOUND');
    mockFetch(429, { status: false, message: 'rate limited' });
    expect((await adapter.findTransferByReference(ref)).outcome).toBe('AMBIGUOUS');
  });
});

describe('Flutterwave lookup classification (v1.0.9 §12.1)', () => {
  const adapter = new FlutterwavePayoutAdapter(flwConfig);
  const ref = 'kdo-payout-wd-1-1';

  it('a valid existing transfer classifies FOUND with the normalized bank identity', async () => {
    mockFetch(200, {
      status: 'success',
      data: { id: 33411, status: 'successful', reference: ref, amount: 10000, currency: 'NGN', bank_code: '058', account_number: '01000000010', beneficiary_name: 'Tolu Robert' },
    });
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('FOUND');
    expect(result.transfer?.amountMinor).toBe(1_000_000n);
    expect(result.transfer?.beneficiaryRef).toMatch(/^flw-bank:/);
  });

  // v1.0.12 §5 — CORRECTED expectation. The v1.0.9 matrix accepted a bare
  // metadata-free array as a complete legacy result; v1.0.12 removes that
  // classification: on the current paginated endpoint a bare array is
  // byte-indistinguishable from an incomplete response — AMBIGUOUS. Only a
  // CONSISTENT zero-total pagination (the companion test below) is
  // authoritative absence.
  it('a bare metadata-free array is AMBIGUOUS (v1.0.12 §5 — never authoritative absence)', async () => {
    mockFetch(200, { status: 'success', data: [] });
    const result = await adapter.findTransferByReference(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  // v1.0.10 §3.3 — CORRECTED expectation. The v1.0.9 matrix accepted an empty
  // paginated list WITHOUT pagination metadata as authoritative absence; the
  // v1.0.10 finding closes exactly that hole: with the paginated contract,
  // required pagination fields that are missing make the response
  // unverifiable — AMBIGUOUS (never NOT_FOUND). Authoritative absence now
  // requires a CONSISTENT zero-total pagination (the companion test below).
  it('an EMPTY paginated list without pagination metadata is AMBIGUOUS (v1.0.10 §3: missing required metadata)', async () => {
    mockFetch(200, { status: 'success', data: { content: [] } });
    const result = await adapter.findTransferByReference(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('an EMPTY paginated list with a CONSISTENT zero-total pagination is NOT_FOUND (v1.0.10 §3)', async () => {
    mockFetch(200, { status: 'success', data: { content: [], meta: { pagination: { total: 0, current_page: 1, total_pages: 1, per_page: 30 } } } });
    const result = await adapter.findTransferByReference(ref);
    expect(result.outcome).toBe('NOT_FOUND');
  });

  it('an EMPTY paginated list whose metadata reports existing records is AMBIGUOUS (v1.0.10 §3 finding)', async () => {
    mockFetch(200, { status: 'success', data: { content: [], meta: { pagination: { total: 1, current_page: 1, total_pages: 1, per_page: 30 } } } });
    const result = await adapter.findTransferByReference(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('NOT_FOUND');
  });

  it('an id-lookup 404 has NO documented authoritative body — AMBIGUOUS', async () => {
    mockFetch(404, { status: 'error', message: 'No transfer matches' });
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  const cases: Array<[string, number, unknown]> = [
    ['HTTP 401', 401, { status: 'error', message: 'Invalid secret key' }],
    ['HTTP 403', 403, { status: 'error', message: 'Forbidden' }],
    ['HTTP 429', 429, { status: 'error', message: 'Rate limit exceeded' }],
    ['HTTP 500', 500, { status: 'error', message: 'server error' }],
    ['HTTP 502', 502, 'bad gateway'],
    ['unknown provider error (HTTP 400)', 400, { status: 'error', message: 'unknown-code-xyz' }],
  ];
  for (const [name, status, body] of cases) {
    it(`${name} never proves non-existence (AMBIGUOUS/ERROR)`, async () => {
      mockFetch(status, body);
      const result = await adapter.getTransfer(ref);
      expect(['AMBIGUOUS', 'ERROR']).toContain(result.outcome);
      expect(result.outcome).not.toBe('NOT_FOUND');
      const byRef = await adapter.findTransferByReference(ref);
      expect(['AMBIGUOUS', 'ERROR']).toContain(byRef.outcome);
    });
  }

  it('a timeout classifies AMBIGUOUS and never throws', async () => {
    mockTransportFailure(new Error('The operation was aborted due to timeout'));
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('a connection reset classifies AMBIGUOUS', async () => {
    mockTransportFailure(new Error('read ECONNRESET'));
    expect((await adapter.getTransfer(ref)).outcome).toBe('AMBIGUOUS');
    expect((await adapter.findTransferByReference(ref)).outcome).toBe('AMBIGUOUS');
  });

  it('malformed JSON classifies AMBIGUOUS', async () => {
    mockFetch(200, 'oops');
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('an empty response classifies AMBIGUOUS', async () => {
    mockFetch(200, '');
    expect((await adapter.getTransfer(ref)).outcome).toBe('AMBIGUOUS');
    expect((await adapter.findTransferByReference(ref)).outcome).toBe('AMBIGUOUS');
  });

  it('missing transfer fields on a success envelope classify AMBIGUOUS', async () => {
    mockFetch(200, { status: 'success', data: { amount: 10000 } });
    const result = await adapter.getTransfer(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('a reference lookup returning a list WITHOUT the requested reference is AMBIGUOUS (never proof of absence)', async () => {
    mockFetch(200, { status: 'success', data: [{ id: 9, status: 'successful', reference: 'some-other-ref' }] });
    const result = await adapter.findTransferByReference(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('an error envelope on the reference lookup is AMBIGUOUS (never NOT_FOUND)', async () => {
    mockFetch(200, { status: 'error', message: 'No transfer was found for this reference' });
    const result = await adapter.findTransferByReference(ref);
    expect(result.outcome).toBe('AMBIGUOUS');
  });
});
