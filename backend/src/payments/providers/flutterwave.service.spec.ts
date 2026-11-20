import { ConfigService } from '@nestjs/config';
import { FlutterwaveService } from './flutterwave.service';

/**
 * Unit tests for the Flutterwave webhook verifier.
 * Flutterwave compares the raw `verif-hash` header against the secret hash
 * configured in the provider dashboard (plain secret comparison).
 */
const HASH = 'fb1d2c3a4b5e6f708192a3b4c5d6e7f8';

function makeService(webhookHash?: string) {
  const config = { get: jest.fn((key: string) => (key === 'payments.flutterwave.webhookHash' ? webhookHash : undefined)) };
  return { service: new FlutterwaveService(config as unknown as ConfigService), config };
}

function payload(reference: string, id = 987654): Buffer {
  return Buffer.from(JSON.stringify({ event: 'completed.transfer', data: { tx_ref: reference, id, status: 'successful' } }));
}

describe('FlutterwaveService.verifyWebhook', () => {
  it('accepts a matching verif-hash and extracts event, reference, event id AND data.status', async () => {
    const { service } = makeService(HASH);
    // dataStatus is mandatory for Flutterwave: 'charge.completed' fires for
    // failed charges too, so the caller MUST gate on data.status === 'successful'.
    await expect(service.verifyWebhook(payload('KDO-FLW12345'), { 'verif-hash': HASH })).resolves.toEqual({
      valid: true,
      eventType: 'completed.transfer',
      reference: 'KDO-FLW12345',
      eventId: '987654',
      dataStatus: 'successful',
    });
  });

  it('surfaces a FAILED data.status so the webhook router can reject the charge', async () => {
    const { service } = makeService(HASH);
    const raw = Buffer.from(JSON.stringify({ event: 'charge.completed', data: { tx_ref: 'KDO-FLWFAIL1', id: 42, status: 'failed' } }));
    const result = await service.verifyWebhook(raw, { 'verif-hash': HASH });
    expect(result.valid).toBe(true);
    expect(result.dataStatus).toBe('failed');
  });

  it('accepts the hash given as a header array (raw express headers)', async () => {
    const { service } = makeService(HASH);
    await expect(service.verifyWebhook(payload('KDO-FLW99999'), { 'verif-hash': [HASH] })).resolves.toMatchObject({
      valid: true,
    });
  });

  it('rejects a mismatched verif-hash', async () => {
    const { service } = makeService(HASH);
    await expect(service.verifyWebhook(payload('KDO-FLW12345'), { 'verif-hash': 'f'.repeat(32) })).resolves.toEqual({
      valid: false,
    });
  });

  it('rejects when the verif-hash header is missing', async () => {
    const { service } = makeService(HASH);
    await expect(service.verifyWebhook(payload('KDO-FLW12345'), {})).resolves.toEqual({ valid: false });
  });

  it('rejects when no webhook hash is configured on the server side', async () => {
    const { service } = makeService(undefined);
    await expect(service.verifyWebhook(payload('KDO-FLW12345'), { 'verif-hash': HASH })).resolves.toEqual({
      valid: false,
    });
  });

  it('rejects a matching hash over malformed JSON', async () => {
    const { service } = makeService(HASH);
    await expect(service.verifyWebhook(Buffer.from('<not-json>'), { 'verif-hash': HASH })).resolves.toEqual({
      valid: false,
    });
  });

  it('omits eventId when the payload has no data.id', async () => {
    const { service } = makeService(HASH);
    const raw = Buffer.from(JSON.stringify({ event: 'charge.completed', data: { tx_ref: 'KDO-FLW00001' } }));
    const result = await service.verifyWebhook(raw, { 'verif-hash': HASH });
    expect(result).toMatchObject({ valid: true, eventType: 'charge.completed', reference: 'KDO-FLW00001' });
    expect(result.eventId).toBeUndefined();
  });
});

describe('FlutterwaveService.isEnabled', () => {
  it('is disabled without a configured secret key', () => {
    const config = { get: jest.fn(() => undefined) };
    expect(new FlutterwaveService(config as unknown as ConfigService).isEnabled()).toBe(false);
  });

  it('is enabled when a secret key is present', () => {
    const config = { get: jest.fn((key: string) => (key === 'payments.flutterwave.secretKey' ? 'sk' : undefined)) };
    expect(new FlutterwaveService(config as unknown as ConfigService).isEnabled()).toBe(true);
  });

  it('exposes the FLUTTERWAVE provider name', () => {
    const { service } = makeService(HASH);
    expect(service.name).toBe('FLUTTERWAVE');
  });
});
