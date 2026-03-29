/**
 * Screenshot capture script for Styrby landing pages.
 * Captures real screenshots from the live site to replace mock/placeholder images.
 *
 * Usage: node capture-screenshots.mjs
 */

import { chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.join(__dirname, 'public', 'screenshots');
const BASE_URL = 'https://styrbyapp.com';
const VIEWPORT = { width: 1440, height: 900 };

const PAGES_TO_CAPTURE = [
  {
    url: '/',
    filename: 'homepage.png',
    description: 'Full homepage — hero, social proof, features strip',
    waitFor: 'networkidle',
    fullPage: false,
  },
  {
    url: '/features',
    filename: 'features-page.png',
    description: 'Features page — full feature breakdown',
    waitFor: 'networkidle',
    fullPage: false,
  },
  {
    url: '/pricing',
    filename: 'pricing-page.png',
    description: 'Pricing page — plan cards',
    waitFor: 'networkidle',
    fullPage: false,
  },
  {
    url: '/login',
    filename: 'login-page.png',
    description: 'Login page — auth UI',
    waitFor: 'networkidle',
    fullPage: false,
  },
  {
    url: '/dashboard',
    filename: 'dashboard-overview.png',
    description: 'Dashboard overview — may redirect to login',
    waitFor: 'networkidle',
    fullPage: false,
  },
];

async function captureScreenshots() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2, // Retina-quality screenshots
  });
  const page = await context.newPage();

  const results = [];

  for (const config of PAGES_TO_CAPTURE) {
    const url = `${BASE_URL}${config.url}`;
    const outputPath = path.join(SCREENSHOTS_DIR, config.filename);

    console.log(`\nCapturing: ${config.description}`);
    console.log(`  URL: ${url}`);
    console.log(`  Output: ${outputPath}`);

    try {
      await page.goto(url, { waitUntil: config.waitFor, timeout: 30000 });

      // Wait for any animations to settle
      await page.waitForTimeout(1500);

      // Record final URL (to detect redirects)
      const finalUrl = page.url();
      const redirected = finalUrl !== url;

      await page.screenshot({
        path: outputPath,
        fullPage: config.fullPage,
        type: 'png',
      });

      results.push({
        filename: config.filename,
        status: 'captured',
        originalUrl: url,
        finalUrl,
        redirected,
        description: config.description,
      });

      console.log(`  ✓ Captured${redirected ? ` (redirected to: ${finalUrl})` : ''}`);
    } catch (err) {
      results.push({
        filename: config.filename,
        status: 'error',
        originalUrl: url,
        error: err.message,
        description: config.description,
      });
      console.error(`  ✗ Error: ${err.message}`);
    }
  }

  await browser.close();

  console.log('\n--- Summary ---');
  for (const r of results) {
    const icon = r.status === 'captured' ? '✓' : '✗';
    const note = r.redirected ? ` [redirected → ${r.finalUrl}]` : '';
    console.log(`${icon} ${r.filename}${note}`);
  }

  return results;
}

captureScreenshots().catch(console.error);
