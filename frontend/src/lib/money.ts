/**
 * Money display helpers. The API returns amounts as STRINGS in minor units
 * (kobo/cents). Parsing to float is safe only for display formatting —
 * never for accumulating balances.
 */
export const CURRENCY_DECIMALS: Record<string, number> = {
  NGN: 2, USD: 2, GBP: 2, EUR: 2, CAD: 2, GHS: 2, KES: 2, ZAR: 2, ZMW: 2, XOF: 0, XAF: 0,
};

export function decimalsOf(currency: string): number {
  return CURRENCY_DECIMALS[currency.toUpperCase()] ?? 2;
}

export function formatMoney(minor: string | number | bigint, currency: string): string {
  const b = typeof minor === 'bigint' ? minor : BigInt(Math.round(Number(minor) || 0));
  const d = decimalsOf(currency);
  const value = Number(b) / Math.pow(10, d);
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(d)}`;
  }
}

/** Major-unit number from minor units (for amount inputs bound to minor values). */
export function majorValue(minor: string | number, currency: string): number {
  return Number(minor) / Math.pow(10, decimalsOf(currency));
}

export function minorFromMajor(value: number, currency: string): number {
  const d = decimalsOf(currency);
  return Math.round(value * Math.pow(10, d));
}

export function progressPercent(raised: string | number, target: string | number): number {
  const r = Number(raised);
  const t = Number(target);
  if (!t || t <= 0) return 0;
  return Math.min(100, Math.round((r / t) * 100));
}
