import { describe, expect, it } from 'vitest';
import { daysUntil, formatDate, initials, truncate } from '@/lib/utils';

describe('formatDate', () => {
  it('formats a valid ISO date string', () => {
    const formatted = formatDate('2024-01-15T12:00:00Z');
    expect(formatted).not.toBe('');
    expect(formatted).toContain('2024');
    expect(formatted).toContain('Jan');
    expect(formatted).toContain('15');
  });

  it('accepts Date objects as well as strings', () => {
    const formatted = formatDate(new Date('2024-01-15T12:00:00Z'));
    expect(formatted).toContain('2024');
  });

  it('returns an empty string for invalid input', () => {
    expect(formatDate('not-a-date')).toBe('');
  });

  it('returns an empty string for null/undefined', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });
});

describe('daysUntil', () => {
  it('returns ~7 for a deadline one week out', () => {
    const deadline = new Date(Date.now() + 7 * 86400000);
    const days = daysUntil(deadline);
    expect(days).toBe(7);
  });

  it('returns a negative integer for past dates (actual behavior — no clamping to null)', () => {
    const days = daysUntil(new Date(Date.now() - 3 * 86400000));
    expect(days).not.toBeNull();
    expect(Number.isInteger(days)).toBe(true);
    expect(days).toBeLessThan(0);
    expect(days).toBe(-3);
  });

  it('parses ISO strings', () => {
    const iso = new Date(Date.now() + 86400000).toISOString();
    expect(daysUntil(iso)).toBe(1);
  });

  it('returns null for null/undefined input', () => {
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil(undefined)).toBeNull();
  });
});

describe('initials', () => {
  it('takes the first letter of each name, uppercased', () => {
    expect(initials('Amara', 'Okafor')).toBe('AO');
    expect(initials('john', 'doe')).toBe('JD');
  });

  it('handles missing first or last name', () => {
    expect(initials('Amara')).toBe('A');
    expect(initials(undefined, 'Okafor')).toBe('O');
    expect(initials('Amara', null)).toBe('A');
  });

  it('falls back to K when there is no name at all', () => {
    expect(initials(null, null)).toBe('K');
    expect(initials('', '')).toBe('K');
  });
});

describe('truncate', () => {
  it('shortens long text with an ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
  });

  it('returns text of at most `length` characters when truncated', () => {
    const result = truncate('a very long campaign title indeed', 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith('…')).toBe(true);
  });

  it('leaves text at or under the limit untouched', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('exact!!', 7)).toBe('exact!!');
  });
});
