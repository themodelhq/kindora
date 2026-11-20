import { BadRequestException } from '@nestjs/common';

/**
 * KINDORA v1.0.8 §3.2 — THE centralized manual-settlement channel allowlist.
 *
 * This is the single, explicit, server-controlled list of genuine offline /
 * manual settlement channels. It is the security boundary for manual
 * settlement:
 *  - API providers (PAYSTACK, PAYSTACK_TRANSFER, FLUTTERWAVE,
 *    FLUTTERWAVE_TRANSFER, STRIPE, PAYPAL) are NEVER valid manual channels;
 *  - every unknown value is rejected;
 *  - there is NO regex-based recognition and NO administrator-supplied free
 *    text anywhere in this path — the DTO uses an explicit @IsIn of exactly
 *    these values, and the service layer re-asserts it independently.
 *
 * Aliases: `MANUAL_BANK` is the v1.0.4–v1.0.7 legacy channel name found on
 * historical rows. It maps to MANUAL_BANK_TRANSFER for READ-side continuity
 * (retry defaults on old withdrawals); it is NOT itself a valid settlement
 * input for new v1.0.8 settlements.
 */

export const MANUAL_SETTLEMENT_CHANNELS = ['MANUAL_BANK_TRANSFER', 'CASH', 'APPROVED_OFFLINE_CHANNEL'] as const;

export type ManualSettlementChannel = (typeof MANUAL_SETTLEMENT_CHANNELS)[number];

/** API providers and other values that manual settlement must ALWAYS reject. */
export const API_PROVIDERS_BLOCKED_FOR_MANUAL_SETTLEMENT = [
  'PAYSTACK',
  'PAYSTACK_TRANSFER',
  'FLUTTERWAVE',
  'FLUTTERWAVE_TRANSFER',
  'STRIPE',
  'PAYPAL',
  'MOCK',
] as const;

/** v1.0.4–v1.0.7 historical channel names -> their v1.0.8 canonical channel. */
export const LEGACY_MANUAL_CHANNEL_ALIASES: Record<string, ManualSettlementChannel> = {
  MANUAL_BANK: 'MANUAL_BANK_TRANSFER',
};

export function isManualSettlementChannel(value: unknown): value is ManualSettlementChannel {
  return typeof value === 'string' && (MANUAL_SETTLEMENT_CHANNELS as readonly string[]).includes(value);
}

/**
 * Strict allowlist assertion. The error messages name exactly WHY a value was
 * rejected (API provider vs unknown) so audit trails and API consumers can
 * distinguish the cases without any recognition heuristic.
 */
export function assertManualSettlementChannel(value: unknown): ManualSettlementChannel {
  if (isManualSettlementChannel(value)) return value;

  if (value == null || value === '') {
    throw new BadRequestException('Manual settlement requires an explicit settlement channel (missing provider)');
  }
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : String(value ?? '').toUpperCase();
  // Case-insensitive acceptance of the allowlisted channels — and ONLY those.
  if (isManualSettlementChannel(upper)) return upper;
  if ((API_PROVIDERS_BLOCKED_FOR_MANUAL_SETTLEMENT as readonly string[]).includes(upper)) {
    throw new BadRequestException(
      `"${upper}" is an API settlement provider — it can never be used for manual settlement. ` +
        `Allowed channels: ${MANUAL_SETTLEMENT_CHANNELS.join(', ')}`,
    );
  }
  if (upper in LEGACY_MANUAL_CHANNEL_ALIASES) {
    throw new BadRequestException(
      `"${upper}" is a legacy channel name — use "${LEGACY_MANUAL_CHANNEL_ALIASES[upper]}" for manual settlement`,
    );
  }
  throw new BadRequestException(
    `"${String(value).slice(0, 64)}" is not an approved manual settlement channel. ` +
      `Allowed channels: ${MANUAL_SETTLEMENT_CHANNELS.join(', ')}`,
  );
}

/**
 * Read-side alias resolution for HISTORICAL rows only (retry defaults, list
 * rendering). Returns null for anything that is neither a current channel nor
 * a legacy alias — callers treat null as "not a manual channel".
 */
export function normalizeLegacyManualChannel(value: string): ManualSettlementChannel | null {
  if (isManualSettlementChannel(value)) return value;
  return LEGACY_MANUAL_CHANNEL_ALIASES[value.trim().toUpperCase()] ?? null;
}
