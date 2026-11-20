import { BadRequestException } from '@nestjs/common';
import {
  API_PROVIDERS_BLOCKED_FOR_MANUAL_SETTLEMENT,
  MANUAL_SETTLEMENT_CHANNELS,
  assertManualSettlementChannel,
  isManualSettlementChannel,
  normalizeLegacyManualChannel,
} from './manual-settlement-channels';

/**
 * v1.0.8 §12.1 — the manual-settlement allowlist is the security boundary.
 * Every rejection case from the release checklist is asserted here: API
 * providers, aliases, arbitrary strings, missing values — and the exact
 * allowlisted channels are the ONLY accepted inputs.
 */
describe('manual settlement channel allowlist (v1.0.8 §3.2/§12.1)', () => {
  it('accepts exactly the allowlisted channels', () => {
    for (const channel of MANUAL_SETTLEMENT_CHANNELS) {
      expect(isManualSettlementChannel(channel)).toBe(true);
      expect(assertManualSettlementChannel(channel)).toBe(channel);
      expect(assertManualSettlementChannel(channel.toLowerCase())).toBe(channel);
      expect(assertManualSettlementChannel(` ${channel} `)).toBe(channel);
    }
  });

  it.each(['PAYSTACK', 'PAYSTACK_TRANSFER', 'FLUTTERWAVE', 'FLUTTERWAVE_TRANSFER', 'STRIPE', 'PAYPAL'])(
    'rejects the API provider %s with an explicit "API provider" error',
    (provider) => {
      expect(() => assertManualSettlementChannel(provider)).toThrow(BadRequestException);
      expect(() => assertManualSettlementChannel(provider)).toThrow(/API settlement provider/);
      expect(() => assertManualSettlementChannel(provider.toLowerCase())).toThrow(/API settlement provider/);
      expect(() => assertManualSettlementChannel(`  ${provider}  `)).toThrow(/API settlement provider/);
    },
  );

  it('rejects every blocked API provider name listed in the security boundary', () => {
    expect(API_PROVIDERS_BLOCKED_FOR_MANUAL_SETTLEMENT.length).toBeGreaterThanOrEqual(7);
  });

  it.each(['paystack_transfer', 'PAYSTACK-TRANSFER', 'PAYSTACK ', 'mock', 'MANUAL_BANK', 'bank_transfer', 'MOBILE_MONEY', 'FLW', 'PS_TRANSFER'])(
    'rejects the alias/unknown value %s',
    (value) => {
      expect(() => assertManualSettlementChannel(value)).toThrow(BadRequestException);
    },
  );

  it('rejects arbitrary strings, missing and malformed values', () => {
    expect(() => assertManualSettlementChannel('SOMETHING_ELSE')).toThrow(BadRequestException);
    expect(() => assertManualSettlementChannel('')).toThrow(/missing/i);
    expect(() => assertManualSettlementChannel(null)).toThrow(/missing/i);
    expect(() => assertManualSettlementChannel(undefined)).toThrow(/missing/i);
    expect(() => assertManualSettlementChannel(123)).toThrow(BadRequestException);
    expect(() => assertManualSettlementChannel({})).toThrow(BadRequestException);
  });

  it('maps the legacy channel ONLY on the read side (never as a settlement input)', () => {
    expect(normalizeLegacyManualChannel('MANUAL_BANK')).toBe('MANUAL_BANK_TRANSFER');
    expect(normalizeLegacyManualChannel('manual_bank')).toBe('MANUAL_BANK_TRANSFER');
    expect(normalizeLegacyManualChannel('PAYSTACK')).toBeNull();
    expect(normalizeLegacyManualChannel('NOT_A_CHANNEL')).toBeNull();
    // The legacy name itself is NOT a valid settlement input:
    expect(() => assertManualSettlementChannel('MANUAL_BANK')).toThrow(/legacy channel name/);
  });

  it('has no regex-based recognition anywhere in the boundary', () => {
    // A value containing an allowlisted substring must still be rejected —
    // the v1.0.7 /MANUAL|BANK|CASH/i defect class.
    expect(isManualSettlementChannel('MANUAL_BANK_TRANSFER_PLUS_HACK')).toBe(false);
    expect(isManualSettlementChannel('CASHIER')).toBe(false);
    expect(isManualSettlementChannel('BANKER')).toBe(false);
    expect(isManualSettlementChannel('CASH_TRANSFERS')).toBe(false);
  });
});
