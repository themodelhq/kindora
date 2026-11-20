/**
 * Money helpers. All amounts are BigInt values in MINOR units.
 * Floating point is used ONLY for display formatting, never for balances.
 */

export const CURRENCY_DECIMALS: Record<string, number> = {
  NGN: 2,
  USD: 2,
  GBP: 2,
  EUR: 2,
  CAD: 2,
  GHS: 2,
  KES: 2,
  ZAR: 2,
  ZMW: 2,
  XOF: 0,
  XAF: 0,
};

export function decimalsOf(currency: string): number {
  return CURRENCY_DECIMALS[currency.toUpperCase()] ?? 2;
}

export function toMinor(amount: number | string, currency: string): bigint {
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${amount}`);
  const d = decimalsOf(currency);
  // Parse from string to avoid float artifacts (e.g. 19.99 * 100 = 1998.99...)
  const [whole, frac = ''] = n.toFixed(d).split('.');
  const paddedFrac = frac.padEnd(d, '0').slice(0, d);
  return BigInt(`${whole}${paddedFrac || '0'.repeat(d)}` || '0');
}

export function majorValue(minor: bigint | string, currency: string): number {
  const b = typeof minor === 'string' ? BigInt(minor) : minor;
  return Number(b) / Math.pow(10, decimalsOf(currency));
}

export function formatMoney(minor: bigint | string, currency: string): string {
  const b = typeof minor === 'string' ? BigInt(minor) : minor;
  const value = majorValue(b, currency);
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: decimalsOf(currency),
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(decimalsOf(currency))}`;
  }
}

export function percentOf(minor: bigint, percent: number): bigint {
  if (percent <= 0) return 0n;
  return (minor * BigInt(Math.round(percent * 100))) / 10000n;
}

export function sumMinor(values: (bigint | string)[]): bigint {
  return values.reduce<bigint>((acc, v) => acc + (typeof v === 'string' ? BigInt(v) : v), 0n);
}
