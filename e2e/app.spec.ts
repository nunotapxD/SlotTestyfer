import { expect, test } from '@playwright/test';

test.describe('SlotTestyfer in the browser', () => {
  test('plays a round and replays it exactly', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Fictional credits only.')).toBeVisible();
    await expect(page.locator('.reel .cell').first()).toBeVisible();

    await page.getByRole('button', { name: /^Spin/ }).click();
    const meta = page.locator('.round-info .round-meta');
    await expect(meta).toContainText('seed');
    const first = await meta.locator('.mono').allTextContents();

    await page.getByRole('button', { name: 'Replay this round' }).click();
    await expect(page.getByRole('button', { name: /^Spin/ })).toBeEnabled({ timeout: 30_000 });
    expect(await meta.locator('.mono').allTextContents()).toEqual(first);
  });

  test('runs a simulation to a verdict', async ({ page }) => {
    await page.goto('/');
    await page.locator('#sim-rounds').selectOption('100000');
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await expect(page.locator('.result .verdict b')).toHaveText(/PASS|FAIL|INCONCLUSIVE/, {
      timeout: 60_000,
    });
    await expect(page.locator('.result .hero-rtp')).toContainText('%');
    await expect(page.locator('.history-table tbody tr').first()).toContainText('100k');
  });

  test('analyzes two games side by side', async ({ page }) => {
    await page.goto('/#analyze');
    await page.getByLabel('Fruits 5x3').uncheck();
    await page.locator('.analyze-form select').first().selectOption('20000');
    await page.locator('.analyze-form select').nth(1).selectOption('200');
    await page.getByRole('button', { name: 'Analyze' }).click();
    await expect(page.locator('.word-card')).toHaveCount(2, { timeout: 60_000 });
    await expect(page.locator('.compare-table')).toContainText('Ahead after 100 rounds');
  });

  test('streams a live run, pauses it and stops it', async ({ page }) => {
    await page.goto('/#live');
    const lane = page.locator('.lane').first();
    await lane.getByRole('button', { name: 'Start' }).click();
    await expect(lane.locator('.hero-rtp')).toContainText('%', { timeout: 15_000 });
    await lane.getByRole('button', { name: 'Pause' }).click();
    await expect(lane.locator('.tag')).toHaveText('paused');
    await lane.getByRole('button', { name: 'Resume' }).click();
    await expect(lane.locator('.tag')).toHaveText('running');
    await lane.getByRole('button', { name: 'Stop' }).click();
    await expect(lane.locator('.tag')).toHaveText('cancelled');
  });
});
