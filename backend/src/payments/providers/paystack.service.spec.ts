import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PaystackService } from './paystack.service';

/**
 * Unit tests for the Paystack webhook verifier.
 * Paystack signs webhooks with HMAC-SHA512 of the RAW body using the secret
 * key; the expected signature is recomputed here with node crypto.
 */
const SECRET = 'sk_test_kindora_unit';

function makeService(secret?: string) {
  const config = { get: jest.fn((key: string) => (key === 'payments.paystack.secretKey' ? secret : undefined)) };
  return { service: new PaystackService(config as unknown as ConfigService), config };
}

function signedPayload(event: string, reference: string): { raw: Buffer; signature: string } {
  const raw = Buffer.from(JSON.stringify({ event, data: { reference } }));
  const signature = createHmac('sha512', SECRET).update(raw).digest('hex');
  return { raw, signature };
}

describe('PaystackService.verifyWebhook', () => {
  it('accepts a valid HMAC-SHA512 signature and extracts event + reference + derived event id', async () => {
    const { service } = makeService(SECRET);
    const { raw, signature } = signedPayload('charge.success', 'KDO-AB2CDE34');

    // Paystack does not send an event id; the adapter derives one from the
    // signed body (sha256) so exact replays dedupe at the webhook layer.
    await expect(service.verifyWebhook(raw, { 'x-paystack-signature': signature })).resolves.toEqual({
      valid: true,
      eventType: 'charge.success',
      reference: 'KDO-AB2CDE34',
      eventId: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('derives the SAME event id for an identical replayed body (replay dedupe)', async () => {
    const { service } = makeService(SECRET);
    const { raw, signature } = signedPayload('charge.success', 'KDO-REPLAY01');
    const first = await service.verifyWebhook(raw, { 'x-paystack-signature': signature });
    const second = await service.verifyWebhook(Buffer.from(raw), { 'x-paystack-signature': signature });
    expect(second.valid).toBe(true);
    expect(second.eventId).toBe(first.eventId);
  });

  it('accepts the signature given as a header array (raw express headers)', async () => {
    const { service } = makeService(SECRET);
    const { raw, signature } = signedPayload('charge.success', 'KDO-XY765432');
    await expect(service.verifyWebhook(raw, { 'x-paystack-signature': [signature] })).resolves.toMatchObject({
      valid: true,
    });
  });

  it('verifies over the exact raw bytes (string body)', async () => {
    const { service } = makeService(SECRET);
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'KDO-STR12345' } });
    const signature = createHmac('sha512', SECRET).update(body).digest('hex');
    await expect(service.verifyWebhook(body, { 'x-paystack-signature': signature })).resolves.toMatchObject({
      valid: true,
      reference: 'KDO-STR12345',
    });
  });

  it('rejects a tampered signature (HMAC over different bytes)', async () => {
    const { service } = makeService(SECRET);
    const { raw, signature } = signedPayload('charge.success', 'KDO-AB2CDE34');
    const tampered = Buffer.concat([raw, Buffer.from(' ')]);
    await expect(service.verifyWebhook(tampered, { 'x-paystack-signature': signature })).resolves.toEqual({
      valid: false,
    });
  });

  it('rejects a bad signature without throwing', async () => {
    const { service } = makeService(SECRET);
    const { raw } = signedPayload('charge.success', 'KDO-AB2CDE34');
    await expect(service.verifyWebhook(raw, { 'x-paystack-signature': 'deadbeef'.repeat(16) })).resolves.toEqual({
      valid: false,
    });
  });

  it('rejects when the signature header is missing', async () => {
    const { service } = makeService(SECRET);
    const { raw } = signedPayload('charge.success', 'KDO-AB2CDE34');
    await expect(service.verifyWebhook(raw, {})).resolves.toEqual({ valid: false });
  });

  it('rejects unsigned bodies when no secret key is configured', async () => {
    const { service } = makeService(undefined);
    const { raw, signature } = signedPayload('charge.success', 'KDO-AB2CDE34');
    await expect(service.verifyWebhook(raw, { 'x-paystack-signature': signature })).resolves.toEqual({
      valid: false,
    });
  });

  it('rejects well-signed but malformed JSON payloads', async () => {
    const { service } = makeService(SECRET);
    const raw = Buffer.from('this is not json');
    const signature = createHmac('sha512', SECRET).update(raw).digest('hex');
    await expect(service.verifyWebhook(raw, { 'x-paystack-signature': signature })).resolves.toEqual({
      valid: false,
    });
  });
});

describe('PaystackService.isEnabled', () => {
  it('is disabled without a configured secret key', () => {
    const { service } = makeService(undefined);
    expect(service.isEnabled()).toBe(false);
  });

  it('is enabled when a secret key is present', () => {
    const { service } = makeService(SECRET);
    expect(service.isEnabled()).toBe(true);
  });

  it('exposes the PAYSTACK provider name', () => {
    const { service } = makeService(SECRET);
    expect(service.name).toBe('PAYSTACK');
  });
});
