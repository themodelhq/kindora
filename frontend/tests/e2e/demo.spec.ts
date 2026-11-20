import { expect, test } from '@playwright/test';

/**
 * KINDORA demo end-to-end spec.
 *
 * Runs against the DEMO build (VITE_DEMO_MODE=1): every API call is served by
 * the local demo adapter, so no backend is needed and no authentication is
 * required (the demo adapter accepts every request, donations are simulated).
 *
 * Selectors are deliberately resilient: role/text queries over brittle CSS,
 * and conditional fills for elements that only render in a particular state
 * (guest fields only appear when signed out).
 *
 * Flow: home -> /campaigns -> first campaign detail -> checkout -> preset +
 * provider -> submit -> /donate/status?...mock=1 -> "confirmed".
 */

test.describe.configure({ mode: 'serial' });

test('home renders the KINDORA hero tagline', async ({ page }) => {
  await page.goto('/');

  // The tagline lives under the KINDORA brand in the header (and again in the
  // footer) — assert it is visible anywhere on the page.
  await expect(page.getByText('Goodness, in motion').first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
});

test('campaigns listing shows campaign cards and opens the first one', async ({ page }) => {
  await page.goto('/campaigns');

  const firstCard = page.locator('a[href^="/campaigns/"]').first();
  await expect(firstCard).toBeVisible();

  // Open the first campaign detail page.
  await firstCard.click();
  await expect(page).toHaveURL(/\/campaigns\/[^/]+$/);

  // Title (any non-empty h1) and the donate CTA are visible.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/\S/);
  await expect(page.getByRole('link', { name: /donate/i }).first()).toBeVisible();
});

test('checkout shows amount presets, accepts a preset + provider, and completes the mock donation', async ({ page }) => {
  // Browse -> first campaign -> donate checkout.
  await page.goto('/campaigns');
  await page.locator('a[href^="/campaigns/"]').first().click();
  await expect(page).toHaveURL(/\/campaigns\/[^/]+$/);

  const donateLink = page.getByRole('link', { name: /donate/i }).first();
  await donateLink.click();
  await expect(page).toHaveURL(/\/donate\/[^/]+$/);

  // Amount presets section is rendered (preset buttons + custom amount field).
  const amountSection = page.locator('section', { has: page.getByRole('heading', { name: /choose your amount/i }) });
  await expect(amountSection).toBeVisible();

  // Preset buttons render formatted money values (e.g. "₦25,000.00"); select
  // the 25,000 tier when present, otherwise the first preset.
  const presetButtons = amountSection.locator('button').filter({ hasText: /[\d,]/ });
  await expect(presetButtons.first()).toBeVisible();
  const preferred = presetButtons.filter({ hasText: /25[,\u00a0\u202f]?000/ });
  if ((await preferred.count()) > 0) {
    await preferred.first().click();
  } else {
    await presetButtons.first().click();
  }

  // Guest identity only renders when signed out (demo starts signed out).
  const nameInput = page.getByLabel(/your name/i);
  if ((await nameInput.count()) > 0) {
    await nameInput.first().fill('Playwright Guest');
  }
  const emailInput = page.getByLabel(/email for your receipt/i);
  if ((await emailInput.count()) > 0) {
    await emailInput.first().fill('e2e-demo@kindora.org');
  }

  // Payment method: open the combobox and pick Paystack (or the first option).
  const providerTrigger = page.getByRole('combobox', { name: /payment method/i }).first();
  await expect(providerTrigger).toBeVisible();
  await providerTrigger.click();
  const options = page.getByRole('option');
  await expect(options.first()).toBeVisible();
  const paystack = options.filter({ hasText: /paystack/i });
  if ((await paystack.count()) > 0) {
    await paystack.first().click();
  } else {
    await options.first().click();
  }

  // Submit the donation: the checkout redirects to the status page with a
  // generated reference and the demo marker.
  await page.getByRole('button', { name: /donate/i }).first().click();
  await page.waitForURL(/\/donate\/status\?ref=.+mock=1/, { timeout: 20000 });

  // The demo adapter resolves the donation instantly; the success state shows
  // the "confirmed" copy.
  await expect(page.getByText(/confirmed/i).first()).toBeVisible({ timeout: 15000 });
});
