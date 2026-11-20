import { expect, test } from '@playwright/test';

/**
 * KINDORA demo smoke tests.
 *
 * Selectors here are intentionally resilient: we prefer role/label queries
 * (getByRole, getByLabel) over brittle CSS, and where the UI can vary (a
 * provider select that may or may not offer MOCK, guest fields that only
 * render when signed out) we branch on what is actually present instead of
 * hard-coding one DOM shape.
 *
 * These run against the DEMO build (VITE_DEMO_MODE=1 baked in at build time),
 * so every API call is served by the local demo adapter — no backend needed.
 */

test('home page renders campaigns', async ({ page }) => {
  await page.goto('/');

  // The home h1 carries the tagline; KINDORA itself lives in the header brand.
  // Accept either so copy changes do not break the smoke test.
  const kindoraHeading = page.getByRole('heading', { name: /kindora/i });
  if ((await kindoraHeading.count()) > 0) {
    await expect(kindoraHeading.first()).toBeVisible();
  } else {
    await expect(page.getByRole('link', { name: /kindora.*home/i })).toBeVisible();
  }

  // At least one campaign card link (featured campaigns from the demo adapter).
  await expect(page.locator('a[href^="/campaigns/"]').first()).toBeVisible();
});

test('demo donate flow completes', async ({ page }) => {
  // Browse the campaign list and open the first campaign (resilient path),
  // then jump straight to the donate page for the known demo campaign.
  await page.goto('/campaigns');
  await page.locator('a[href^="/campaigns/"]').first().click();
  await page.goto('/donate/clean-water-for-obosi');

  // Amount is required before the submit button enables.
  const amountInput = page.getByLabel(/custom amount/i);
  if ((await amountInput.count()) > 0) {
    await amountInput.first().fill('25000');
  }

  // Guest details only render when signed out — fill them if present.
  const nameInput = page.getByLabel(/full name/i);
  if ((await nameInput.count()) > 0) {
    await nameInput.first().fill('Playwright Guest');
  }
  const emailInput = page.getByLabel(/email address/i);
  if ((await emailInput.count()) > 0) {
    await emailInput.first().fill('e2e@kindora.org');
  }

  // Select provider MOCK if the payment-method select offers it; otherwise
  // keep whatever default the form preselects (PAYSTACK in the demo data).
  const providerTrigger = page.getByRole('combobox', { name: /payment method/i });
  if ((await providerTrigger.count()) > 0) {
    await providerTrigger.first().click();
    const mockOption = page.getByRole('option', { name: /mock/i });
    if ((await mockOption.count()) > 0) {
      await mockOption.first().click();
    } else {
      await page.keyboard.press('Escape');
    }
  }

  // Submit: prefer the accessible-name match, fall back to the submit button.
  const donateButton = page.getByRole('button', { name: /donate/i });
  if ((await donateButton.count()) > 0) {
    await donateButton.first().click();
  } else {
    await page.locator('button[type=submit]').first().click();
  }

  // Demo checkout redirects to the status page with a generated reference.
  await page.waitForURL(/\/donate\/status\?ref=/, { timeout: 15000 });

  // The demo adapter resolves instantly after the status poll interval
  // (every 2.5s), so allow up to 15s — no waitForTimeout, just a long expect.
  await expect(page.getByText(/confirmed|thank/i).first()).toBeVisible({ timeout: 15000 });
});
