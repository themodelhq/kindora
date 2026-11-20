import { PayoutProviderRejectedError, PayoutTransportError, providerSubmissionReference } from '../payout-provider.adapter';
import { PaystackPayoutAdapter } from './paystack-payout.adapter';
import { FlutterwavePayoutAdapter, flwMajorToMinorFromToken } from './flutterwave-payout.adapter';

/**
 * v1.0.7 §15.1 — provider initiation adapter semantics (official API
 * contract per provider). fetch is mocked at the boundary; response
 * shapes mirror the documented provider payloads.
 */

type FetchMock = jest.SpyInstance;

function mockFetchOnce(status: number, body: unknown): { mock: FetchMock; lastInit: () => RequestInit } {
  const captured: RequestInit[] = [];
  const mock = jest.spyOn(global, 'fetch').mockImplementation(async (_url: unknown, init?: RequestInit) => {
    captured.push(init as RequestInit);
    return { status, ok: status < 400, text: async () => JSON.stringify(body) } as Response;
  });
  return { mock, lastInit: () => captured[captured.length - 1] as RequestInit };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Paystack payout adapter (v1.0.7 §3.3)', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.paystack.secretKey' ? 'sk_test_x' : undefined)) } as never;
  const adapter = new PaystackPayoutAdapter(config);

  it('recipient creation posts the documented fields and returns the recipient_code as externalRef', async () => {
    const { mock, lastInit } = mockFetchOnce(200, {
      status: true,
      message: 'Transfer recipient created successfully',
      data: { recipient_code: 'RCP_m7ljkv8leesep7p', type: 'nuban', details: { account_number: '01000000010', bank_code: '058', bank_name: 'Guaranty Trust Bank', account_name: 'Tolu Robert' } },
    });
    const resolved = await adapter.resolveBeneficiary({ destination: { accountNumber: '01000000010', bankCode: '058', accountName: 'Tolu Robert' }, currency: 'NGN', method: 'BANK' });
    expect(resolved.externalRef).toBe('RCP_m7ljkv8leesep7p');
    expect(resolved.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    // maskedDetails never carries the full account number
    expect(JSON.stringify(resolved.maskedDetails)).not.toContain('01000000010');
    expect(JSON.stringify(resolved.maskedDetails)).toContain('****0010');
    const body = JSON.parse(String(lastInit().body));
    expect(body).toMatchObject({ type: 'nuban', name: 'Tolu Robert', account_number: '01000000010', bank_code: '058', currency: 'NGN' });
    expect(mock).toHaveBeenCalledWith('https://api.paystack.co/transferrecipient', expect.anything());
  });

  it('recipient validation fails closed on a destination missing bank fields', async () => {
    await expect(adapter.resolveBeneficiary({ destination: { accountName: 'X' }, currency: 'NGN', method: 'BANK' })).rejects.toThrow(PayoutProviderRejectedError);
  });

  it('unsupported corridor (BANK + KES) is rejected, never silently converted', async () => {
    await expect(adapter.resolveBeneficiary({ destination: { accountNumber: '1', bankCode: '058', accountName: 'X' }, currency: 'KES', method: 'BANK' })).rejects.toThrow(/not supported/);
  });

  it('initiation posts source=balance with minor-unit amount and the sanitized provider reference', async () => {
    const { mock, lastInit } = mockFetchOnce(200, {
      status: true,
      message: 'Transfer has been queued',
      data: { id: 860703114, transfer_code: 'TRF_v5tip3zx8nna9o78', reference: 'kdo-payout-wd-1-1', status: 'pending', amount: 1000000, currency: 'NGN' },
    });
    const result = await adapter.initiateTransfer({
      idempotencyKey: 'payout:wd-1:1',
      providerReference: 'kdo-payout-wd-1-1',
      amountMinor: 1_000_000n,
      currency: 'NGN',
      beneficiaryExternalRef: 'RCP_m7ljkv8leesep7p',
      beneficiaryIdentity: {},
      narration: 'KINDORA withdrawal WDR-TEST1',
    });
    expect(result.accepted).toBe(true);
    expect(result.providerTransferRef).toBe('kdo-payout-wd-1-1');
    expect(result.providerTransferId).toBe('860703114');
    const body = JSON.parse(String(lastInit().body));
    expect(body).toMatchObject({ source: 'balance', amount: 1000000, recipient: 'RCP_m7ljkv8leesep7p', reference: 'kdo-payout-wd-1-1', currency: 'NGN' });
    expect(mock).toHaveBeenCalledWith('https://api.paystack.co/transfer', expect.anything());
  });

  it('a definite 4xx rejection maps to PayoutProviderRejectedError (no transfer created)', async () => {
    mockFetchOnce(400, { status: false, message: 'Insufficient balance' });
    await expect(
      adapter.initiateTransfer({
        idempotencyKey: 'payout:wd-1:1',
        providerReference: 'kdo-payout-wd-1-1',
        amountMinor: 1_000_000n,
        currency: 'NGN',
        beneficiaryExternalRef: 'RCP_x',
        beneficiaryIdentity: {},
        narration: 'n',
      }),
    ).rejects.toThrow(PayoutProviderRejectedError);
  });

  it('an ambiguous 5xx maps to PayoutTransportError (transfer MAY exist — never retried blindly)', async () => {
    mockFetchOnce(502, { message: 'bad gateway' });
    await expect(
      adapter.initiateTransfer({
        idempotencyKey: 'payout:wd-1:1',
        providerReference: 'kdo-payout-wd-1-1',
        amountMinor: 1_000_000n,
        currency: 'NGN',
        beneficiaryExternalRef: 'RCP_x',
        beneficiaryIdentity: {},
        narration: 'n',
      }),
    ).rejects.toThrow(PayoutTransportError);
  });

  it('verification returns the recipient_code as the beneficiary identity and minor-unit amount', async () => {
    mockFetchOnce(200, {
      status: true,
      data: {
        id: 860703114,
        transfer_code: 'TRF_v5tip3zx8nna9o78',
        reference: 'kdo-payout-wd-1-1',
        status: 'success',
        amount: 1000000,
        currency: 'NGN',
        recipient: { recipient_code: 'RCP_m7ljkv8leesep7p', details: { account_number: '01000000010', bank_code: '058', account_name: 'Tolu Robert' } },
      },
    });
    const details = await adapter.getTransfer('kdo-payout-wd-1-1');
    // v1.0.9 §2 — lookups return the EXPLICIT outcome shape.
    expect(details.outcome).toBe('FOUND');
    expect(details.transfer?.exists).toBe(true);
    expect(details.transfer?.providerStatus).toBe('success');
    expect(details.transfer?.amountMinor).toBe(1_000_000n);
    expect(details.transfer?.currency).toBe('NGN');
    expect(details.transfer?.beneficiaryRef).toBe('RCP_m7ljkv8leesep7p');
  });

  it('the documented not-found response classifies NOT_FOUND (v1.0.9 §2.2)', async () => {
    mockFetchOnce(404, { status: false, message: 'Transfer not found' });
    const details = await adapter.getTransfer('missing');
    expect(details.outcome).toBe('NOT_FOUND');
    expect(details.transfer).toBeUndefined();
  });

  it('the provider submission reference is deterministic, sanitized and >=16 chars', () => {
    const ref = providerSubmissionReference('payout:ckabcdefghijk:3');
    expect(ref).toBe('kdo-payout-ckabcdefghijk-3');
    expect(ref.length).toBeGreaterThanOrEqual(16);
    expect(ref).toMatch(/^[a-z0-9-]+$/);
    expect(providerSubmissionReference('payout:ckabcdefghijk:3')).toBe(ref);
  });
});

describe('Flutterwave payout adapter (v1.0.7 §3.4)', () => {
  const config = { get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : undefined)) } as never;
  const adapter = new FlutterwavePayoutAdapter(config);

  it('beneficiary resolution calls the account-resolve endpoint and derives a bank fingerprint', async () => {
    const { mock, lastInit } = mockFetchOnce(200, { status: 'success', data: { account_number: '0690000040', account_name: 'ALEX JAMES', bank_code: '044' } });
    const resolved = await adapter.resolveBeneficiary({ destination: { accountNumber: '0690000040', bankCode: '044', accountName: 'Alex James' }, currency: 'NGN', method: 'BANK' });
    expect(resolved.externalRef).toMatch(/^flw-bank:/);
    expect(resolved.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const body = JSON.parse(String(lastInit().body));
    expect(body).toMatchObject({ account_number: '0690000040', account_bank: '044' });
    expect(mock).toHaveBeenCalledWith('https://api.flutterwave.com/v3/accounts/resolve', expect.anything());
  });

  it('an unresolvable destination fails closed (no transfer ever created for it)', async () => {
    mockFetchOnce(400, { status: 'error', message: 'Invalid account details' });
    await expect(adapter.resolveBeneficiary({ destination: { accountNumber: 'bad', bankCode: '044', accountName: 'X' }, currency: 'NGN', method: 'BANK' })).rejects.toThrow(PayoutProviderRejectedError);
  });

  it('initiation posts the documented inline-beneficiary body with MAJOR-unit amount', async () => {
    const { lastInit } = mockFetchOnce(200, { status: 'success', data: { id: 35557, status: 'NEW', reference: 'kdo-payout-wd-1-1', amount: 10000, currency: 'NGN' } });
    const result = await adapter.initiateTransfer({
      idempotencyKey: 'payout:wd-1:1',
      providerReference: 'kdo-payout-wd-1-1',
      amountMinor: 1_000_000n,
      currency: 'NGN',
      beneficiaryExternalRef: 'flw-bank:abc',
      beneficiaryIdentity: { kind: 'bank', bankCode: '044', accountNumber: '0690000040', accountName: 'ALEX JAMES' },
      narration: 'KINDORA withdrawal WDR-TEST1',
    });
    expect(result.accepted).toBe(true);
    expect(result.providerTransferId).toBe('35557');
    expect(result.providerStatus).toBe('NEW');
    const body = JSON.parse(String(lastInit().body));
    expect(body).toMatchObject({ account_bank: '044', account_number: '0690000040', beneficiary_name: 'ALEX JAMES', amount: 10000, currency: 'NGN', reference: 'kdo-payout-wd-1-1' });
  });

  it('mobile money initiation posts the network code + mobile number (v1.0.8 §6.2), only when the channel is enabled', async () => {
    // v1.0.8 §6.3 — the channel is DISABLED by default; initiation fails closed.
    await expect(
      adapter.initiateTransfer({
        idempotencyKey: 'payout:wd-2:1',
        providerReference: 'kdo-payout-wd-2-1',
        amountMinor: 500_000n,
        currency: 'GHS',
        beneficiaryExternalRef: 'flw-mm:abc',
        beneficiaryIdentity: { kind: 'mobile_money', mobileNumber: '0240000000', accountName: 'Kwame' },
        narration: 'n',
      }),
    ).rejects.toThrow(/DISABLED/);

    // With the channel explicitly enabled, the v3 payload carries
    // account_bank = network code and account_number = mobile number.
    const enabledConfig = {
      get: jest.fn((k: string) => (k === 'payments.flutterwave.secretKey' ? 'flw_sk_x' : k === 'payouts.flwMobileMoneyEnabled' ? true : undefined)),
    } as never;
    const enabledAdapter = new FlutterwavePayoutAdapter(enabledConfig);
    const { lastInit } = mockFetchOnce(200, { status: 'success', data: { id: 1, status: 'NEW', reference: 'r1' } });
    await enabledAdapter.initiateTransfer({
      idempotencyKey: 'payout:wd-2:1',
      providerReference: 'kdo-payout-wd-2-1',
      amountMinor: 500_000n,
      currency: 'GHS',
      beneficiaryExternalRef: 'flw-mm:abc',
      beneficiaryIdentity: { kind: 'mobile_money', networkCode: 'MTN', mobileNumber: '0240000000', accountName: 'Kwame' },
      narration: 'n',
    });
    const body = JSON.parse(String(lastInit().body));
    expect(body.account_bank).toBe('MTN');
    expect(body.account_number).toBe('0240000000');
    // v1.0.8 §7 — the amount is an exact decimal token, not a float product.
    expect(body.amount).toBe(5000);
  });

  it('a definite rejection maps to PayoutProviderRejectedError; ambiguous 5xx to PayoutTransportError', async () => {
    mockFetchOnce(400, { status: 'error', message: 'Insufficient funds in wallet' });
    await expect(
      adapter.initiateTransfer({
        idempotencyKey: 'payout:wd-1:1',
        providerReference: 'kdo-payout-wd-1-1',
        amountMinor: 1_000_000n,
        currency: 'NGN',
        beneficiaryExternalRef: 'flw-bank:x',
        beneficiaryIdentity: { kind: 'bank', bankCode: '044', accountNumber: '0690000040', accountName: 'A' },
        narration: 'n',
      }),
    ).rejects.toThrow(PayoutProviderRejectedError);

    mockFetchOnce(503, { status: 'error', message: 'service unavailable' });
    await expect(
      adapter.initiateTransfer({
        idempotencyKey: 'payout:wd-1:1',
        providerReference: 'kdo-payout-wd-1-1',
        amountMinor: 1_000_000n,
        currency: 'NGN',
        beneficiaryExternalRef: 'flw-bank:x',
        beneficiaryIdentity: { kind: 'bank', bankCode: '044', accountNumber: '0690000040', accountName: 'A' },
        narration: 'n',
      }),
    ).rejects.toThrow(PayoutTransportError);
  });

  it('verification converts MAJOR units to minor exactly and derives the beneficiary fingerprint from transfer fields', async () => {
    mockFetchOnce(200, { status: 'success', data: { id: 35557, status: 'successful', reference: 'kdo-payout-wd-1-1', amount: 10000, currency: 'NGN', bank_code: '044', account_number: '0690000040', beneficiary_name: 'ALEX JAMES' } });
    const details = await adapter.getTransfer('35557');
    // v1.0.9 §2 — lookups return the EXPLICIT outcome shape.
    expect(details.outcome).toBe('FOUND');
    expect(details.transfer?.exists).toBe(true);
    expect(details.transfer?.amountMinor).toBe(1_000_000n);
    expect(details.transfer?.beneficiaryRef).toMatch(/^flw-bank:/);
    // The verification fingerprint must equal the resolution fingerprint for
    // the same destination — the settlement identity check.
    const resolved = await (async () => {
      mockFetchOnce(200, { status: 'success', data: { account_number: '0690000040', account_name: 'ALEX JAMES', bank_code: '044' } });
      return adapter.resolveBeneficiary({ destination: { accountNumber: '0690000040', bankCode: '044', accountName: 'ALEX JAMES' }, currency: 'NGN', method: 'BANK' });
    })();
    expect(details.transfer?.beneficiaryRef).toBe(resolved.externalRef);
  });

  it('major->minor conversion is exact from raw decimal tokens (v1.0.8 §7 — no float)', () => {
    // v1.0.8: conversion accepts the RAW decimal token (as transmitted by the
    // provider), never a JS number — the legacy float multiply/round path is
    // removed. Values above 2^53 remain exact.
    expect(flwMajorToMinorFromToken('10000', 'NGN')).toBe(1_000_000n);
    expect(flwMajorToMinorFromToken('0.01', 'NGN')).toBe(1n);
    expect(flwMajorToMinorFromToken('123.45', 'GHS')).toBe(12345n);
    expect(flwMajorToMinorFromToken('10.00', 'NGN')).toBe(1_000n);
    expect(flwMajorToMinorFromToken('500', 'XOF')).toBe(500n); // zero-decimal currency
    expect(flwMajorToMinorFromToken('90071992547409.93', 'NGN')).toBe(9_007_199_254_740_993n); // > 2^53 minor units, exact
    expect(() => flwMajorToMinorFromToken('0.001', 'NGN')).toThrow(); // 3 decimals for a 2-decimal currency — fail closed
    expect(() => flwMajorToMinorFromToken('-1.00', 'NGN')).toThrow();
  });
});
