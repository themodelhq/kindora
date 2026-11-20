import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(input: string | Date | undefined | null): string {
  if (!input) return '';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function relativeTime(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(d);
}

export function daysUntil(input: string | Date | null | undefined): number | null {
  if (!input) return null;
  const d = typeof input === 'string' ? new Date(input) : input;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

export function initials(first?: string | null, last?: string | null): string {
  return `${(first ?? '').charAt(0)}${(last ?? '').charAt(0)}`.toUpperCase() || 'K';
}

export function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
