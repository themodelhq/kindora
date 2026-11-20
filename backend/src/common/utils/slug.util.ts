import { randomBytes } from 'node:crypto';

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const suffix = randomBytes(3).toString('hex');
  return `${base || 'item'}-${suffix}`;
}

export function inviteCode(): string {
  return randomBytes(4).toString('hex');
}
