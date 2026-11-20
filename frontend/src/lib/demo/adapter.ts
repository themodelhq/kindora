import {
  DEMO_CAMPAIGNS,
  DEMO_CIRCLES,
  DEMO_IMPACT,
  DEMO_LEDGER,
  DEMO_NOTIFICATIONS,
  DEMO_ORGANIZATION,
  DEMO_PAYMENT_METHODS,
  DEMO_USERS,
} from './data';
import type { CampaignDetail, CampaignSummary, Donation } from '@/types/api';

/**
 * Demo-mode request adapter. Intercepts the API layer when VITE_DEMO_MODE is
 * enabled so the UI preview runs without a backend. Donations are simulated
 * locally and clearly labelled. Production builds never load this module.
 */

const delay = (ms = 220) => new Promise((r) => setTimeout(r, ms));

interface DemoRequest {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

interface DemoResponse<T = unknown> {
  data: T;
}

const toSummary = (c: CampaignDetail): CampaignSummary => ({
  id: c.id, slug: c.slug, title: c.title, excerpt: c.excerpt, coverImageUrl: c.coverImageUrl,
  status: c.status, targetAmount: c.targetAmount, raisedAmount: c.raisedAmount,
  donorCount: c.donorCount, currency: c.currency, deadline: c.deadline, country: c.country,
  isFeatured: c.isFeatured, createdAt: c.createdAt, category: c.category, createdBy: c.createdBy,
});

const donations: Donation[] = [];

export async function demoRequest<T>(req: DemoRequest): Promise<T> {
  await delay();
  const { method, body } = req;
  const bare = req.path.replace(/^\/?/, '');
  const p = bare.split('?')[0]; // query-string-free path for matching
  const segments = p.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(bare.split('?')[1] ?? ''));

  // GET /impact/summary
  if (p === 'impact/summary') return DEMO_IMPACT as T;
  if (p === 'impact/transactions') return { total: DEMO_LEDGER.length, items: DEMO_LEDGER } as T;
  if (segments[0] === 'impact' && segments[1] === 'campaigns') {
    const c = DEMO_CAMPAIGNS.find((x) => x.slug === segments[2]);
    return {
      campaign: { title: c?.title, currency: c?.currency ?? 'NGN', raisedAmount: c?.raisedAmount, targetAmount: c?.targetAmount },
      balanceMinor: c?.raisedAmount ?? '0',
      entries: DEMO_LEDGER.flatMap((t) => t.entries.map((e) => ({ ...e, transaction: { type: t.type, postedAt: t.postedAt, description: t.description } }))),
      paidWithdrawals: [],
    } as T;
  }

  if (p === 'payments/methods') return DEMO_PAYMENT_METHODS as T;

  if (segments[0] === 'campaigns' && segments.length === 1 && method === 'GET') {
    let items = DEMO_CAMPAIGNS.map(toSummary);
    if (query.status === 'ACTIVE') items = items.filter((c) => c.status === 'ACTIVE');
    if (query.category) items = items.filter((c) => c.category?.slug === query.category);
    if (query.q) items = items.filter((c) => `${c.title} ${c.excerpt ?? ''}`.toLowerCase().includes(String(query.q).toLowerCase()));
    const sort = query.sort ?? 'trending';
    items = [...items].sort((a, b) =>
      sort === 'newest' ? b.createdAt.localeCompare(a.createdAt)
      : sort === 'target' ? Number(b.targetAmount) - Number(a.targetAmount)
      : sort === 'deadline' ? (a.deadline ?? '').localeCompare(b.deadline ?? '')
      : Number(b.raisedAmount) - Number(a.raisedAmount));
    return { total: items.length, items } as T;
  }

  if (segments[0] === 'campaigns' && segments[1] === 'categories') return (DEMO_CAMPAIGNS.map((c) => c.category).filter(Boolean) as unknown) as T;

  if (segments[0] === 'campaigns' && segments.length === 2 && method === 'GET') {
    const campaign = DEMO_CAMPAIGNS.find((c) => c.slug === segments[1]);
    if (!campaign) throw new Error('Campaign not found');
    return campaign as T;
  }

  if (segments[0] === 'campaigns' && segments[2] === 'donors') {
    return {
      total: 3,
      items: [
        { publicRef: 'KDO-8H2K4M9A', amount: '2500000', currency: 'NGN', message: 'For the boreholes — God bless.', matchedAmount: '2500000', isAnonymous: false, donorName: 'Amara O.', createdAt: new Date().toISOString() },
        { publicRef: 'KDO-Q9P3W7T2', amount: '500000', currency: 'NGN', message: null, matchedAmount: '500000', isAnonymous: true, donorName: 'Anonymous donor', createdAt: new Date(Date.now() - 3600000).toISOString() },
        { publicRef: 'KDO-Z7Y2V6B1', amount: '100000', currency: 'NGN', message: 'Keep going!', matchedAmount: '100000', isAnonymous: false, donorName: 'Chinedu E.', createdAt: new Date(Date.now() - 7200000).toISOString() },
      ],
    } as T;
  }

  if (segments[0] === 'campaigns' && segments[2] === 'updates') {
    return {
      total: 2,
      items: [
        { id: 'u1', title: 'Drilling started on borehole #2', body: 'The rig arrived Monday and casing is going in today. Photos will be uploaded once the pump is installed.', createdAt: new Date(Date.now() - 3 * 86400000).toISOString(), author: { firstName: 'Daniel', lastName: 'Mensah' } },
        { id: 'u2', title: 'Water committee trained', body: 'Twelve committee members completed maintenance training this week.', createdAt: new Date(Date.now() - 10 * 86400000).toISOString(), author: { firstName: 'Daniel', lastName: 'Mensah' } },
      ],
    } as T;
  }

  // POST /donations → simulated checkout
  if (p === 'donations' && method === 'POST') {
    const b = body as { campaignSlug?: string; amountMinor?: number; tipAmountMinor?: number; provider?: string };
    const publicRef = `KDO-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const donation: Donation = {
      publicRef,
      amount: String(b.amountMinor ?? 0),
      tipAmount: String(b.tipAmountMinor ?? 0),
      currency: 'NGN',
      status: 'SUCCEEDED',
      createdAt: new Date().toISOString(),
      succeededAt: new Date().toISOString(),
      receiptNumber: `RCP-${publicRef.slice(4)}`,
      campaign: DEMO_CAMPAIGNS.find((c) => c.slug === b.campaignSlug) && { slug: b.campaignSlug!, title: DEMO_CAMPAIGNS.find((c) => c.slug === b.campaignSlug)!.title },
    };
    donations.unshift(donation);
    // Update the campaign in memory so the UI reflects the gift.
    const c = DEMO_CAMPAIGNS.find((x) => x.slug === b.campaignSlug);
    if (c) {
      c.raisedAmount = String(Number(c.raisedAmount) + Number(b.amountMinor ?? 0));
      c.donorCount += 1;
    }
    return {
      donation: { publicRef, amount: donation.amount, currency: 'NGN', status: 'PENDING' },
      redirectUrl: `/donate/status?ref=${publicRef}&mock=1`,
    } as T;
  }

  if (segments[0] === 'donations' && segments[1] === 'status') return (donations[0] ?? null) as T;
  if (segments[0] === 'donations' && segments.length === 2 && method === 'GET') {
    return (donations.find((d) => d.publicRef === segments[1]) ?? null) as T;
  }
  if (p === 'donations/mine') return { total: donations.length, items: donations } as T;

  // Auth
  if (p === 'auth/login' || p === 'auth/register') {
    const email = String((body as { email?: string })?.email ?? '').toLowerCase();
    const user = email.includes('admin') ? DEMO_USERS.admin : email.includes('organizer') ? DEMO_USERS.organizer : DEMO_USERS.donor;
    return { accessToken: 'demo-token', expiresIn: 900, user } as T;
  }
  if (p === 'auth/me') return { user: DEMO_USERS.donor } as T;

  if (p === 'users/me/notifications') return { total: DEMO_NOTIFICATIONS.length, items: DEMO_NOTIFICATIONS } as T;

  // Circles
  if (segments[0] === 'circles' && segments.length === 1) return { total: DEMO_CIRCLES.length, items: DEMO_CIRCLES } as T;
  if (segments[0] === 'circles' && segments.length === 2) {
    const circle = DEMO_CIRCLES.find((c) => c.slug === segments[1]);
    if (!circle) throw new Error('Circle not found');
    return circle as T;
  }

  // Organizations
  if (segments[0] === 'organizations' && segments.length === 1) return { total: 1, items: [DEMO_ORGANIZATION] } as T;
  if (segments[0] === 'organizations' && segments.length === 2) return DEMO_ORGANIZATION as T;

  // Withdrawals
  if (p === 'withdrawals/mine') return { total: 1, items: [{ id: 'w1', publicRef: 'WDR-K3M9Q2XP', amount: '1500000', feeAmount: '0', netAmount: '1500000', currency: 'NGN', method: 'BANK', status: 'PAID', createdAt: new Date(Date.now() - 5 * 86400000).toISOString(), paidAt: new Date(Date.now() - 4 * 86400000).toISOString(), campaign: { title: 'Clean water for Obosi community', slug: 'clean-water-for-obosi' } }] } as T;

  // Admin
  if (p === 'admin/stats') {
    return {
      users: 2841, campaigns: DEMO_CAMPAIGNS.length, campaignsPending: 2,
      donationsTotalMinor: '38245000', donationsCount: DEMO_IMPACT.totalDonations,
      withdrawalsPending: 1, moderationOpen: 2, fraudOpen: 1,
    } as T;
  }

  // Fallback
  return { demo: true, path: p } as T;
}

export function isDemoMode(): boolean {
  return import.meta.env.VITE_DEMO_MODE === '1' || import.meta.env.VITE_DEMO_MODE === 'true';
}
