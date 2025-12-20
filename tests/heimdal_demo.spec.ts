import { test, expect } from '@playwright/test';

test('open heimdal support page and wait', async ({ page }) => {
  // Go to the requested URL
  await page.goto('https://support.heimdalsecurity.com/hc/en-us');

  // Verify basic load by checking title or just waiting as requested
  // Waiting for 5 seconds
  await page.waitForTimeout(5000);
});
