import { test, expect } from '@playwright/test';

test('open heimdal support page and wait', async ({ page }) => {
  // Go to the requested URL
  await page.goto('https://support.heimdalsecurity.com/hc/en-us');

  // Wait for 5 seconds as requested
  await page.waitForTimeout(5000);
});
