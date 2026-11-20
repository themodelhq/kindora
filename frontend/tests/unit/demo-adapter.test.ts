import { describe, expect, it } from 'vitest';
import type { CampaignDetail, CampaignSummary, ImpactSummary, Paginated } from '@/types/api';

// Enable demo mode for this suite. Vitest (vite-node) exposes import.meta.env
// as a mutable object in Node, and the adapter reads the flag at call time —
// not at import time — so assigning here is enough.
import.meta.env.VITE_DEMO_MODE = '1';

import { demoRequest, isDemoMode } from '@/lib/demo/adapter';

const SLUG = 'clean-water-for-obosi';

describe('demo adapter (VITE_DEMO_MODE=1)', () => {
  it('reports demo mode as enabled', () => {
    expect(isDemoMode()).toBe(true);
  });

  it('serves GET /campaigns as a paginated list with 6 items, filterable by status=ACTIVE', async () => {
    const all = await demoRequest<Paginated<CampaignSummary>>({ method: 'GET', path: '/campaigns' });
    expect(all.total).toBe(6);
    expect(all.items).toHaveLength(6);
    expect(all.items.every((c) => typeof c.slug === 'string' && c.slug.length > 0)).toBe(true);

    const active = await demoRequest<Paginated<CampaignSummary>>({
      method: 'GET',
      path: '/campaigns?status=ACTIVE',
    });
    // 5 ACTIVE campaigns + 1 COMPLETED in the demo dataset.
    expect(active.total).toBeLessThan(all.total);
    expect(active.total).toBe(5);
    expect(active.items.every((c) => c.status === 'ACTIVE')).toBe(true);
  });

  it('serves GET /campaigns/:slug with a single matching pool for clean-water-for-obosi', async () => {
    const detail = await demoRequest<CampaignDetail>({
      method: 'GET',
      path: `/campaigns/${SLUG}`,
    });
    expect(detail.slug).toBe(SLUG);
    expect(detail.title).toContain('Clean water');
    expect(Array.isArray(detail.matchingPools)).toBe(true);
    expect(detail.matchingPools).toHaveLength(1);
    expect(detail.matchingPools[0]?.status).toBe('ACTIVE');
  });

  it('POST /donations returns a publicRef + redirectUrl and increments the campaign raisedAmount', async () => {
    const before = await demoRequest<CampaignDetail>({ method: 'GET', path: `/campaigns/${SLUG}` });
    const raisedBefore = Number(before.raisedAmount);
    const donorsBefore = before.donorCount;

    const res = await demoRequest<{ donation: { publicRef: string }; redirectUrl: string }>({
      method: 'POST',
      path: '/donations',
      body: { campaignSlug: SLUG, amountMinor: 2500000, tipAmountMinor: 0, provider: 'PAYSTACK' },
    });

    expect(res.donation.publicRef).toMatch(/^KDO-/);
    expect(res.redirectUrl).toContain('/donate/status?ref=');
    expect(res.redirectUrl).toContain(res.donation.publicRef);

    const after = await demoRequest<CampaignDetail>({ method: 'GET', path: `/campaigns/${SLUG}` });
    // `before` aliases the same mutated demo object, so compare against the
    // primitive snapshots taken before the POST.
    expect(Number(after.raisedAmount)).toBe(raisedBefore + 2500000);
    expect(after.donorCount).toBe(donorsBefore + 1);
  });

  it('serves GET /impact/summary with the demo totals', async () => {
    const impact = await demoRequest<ImpactSummary>({ method: 'GET', path: '/impact/summary' });
    expect(impact.totalDonations).toBe(1984);
  });

  it('falls back to a generic demo payload for unknown routes', async () => {
    const res = await demoRequest<{ demo: boolean; path: string }>({
      method: 'GET',
      path: '/definitely/not/a/route',
    });
    expect(res.demo).toBe(true);
    expect(res.path).toContain('definitely');
  });
});
