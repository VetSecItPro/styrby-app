const { chromium } = require('playwright');
const { readFileSync } = require('fs');

const SCREENSHOT_DIR = '/Users/airborneshellback/vibecode-projects/styrby-app/packages/styrby-web/public/screenshots';
const BASE_URL = 'https://styrbyapp.com';
const projectRef = 'akmtmxunjhsgldjztdtt';

// Read the auth token
const authData = JSON.parse(readFileSync('/tmp/styrby-auth-token.json', 'utf8'));

/**
 * Build Supabase SSR auth cookies (chunked if payload exceeds 3500 bytes).
 * Uses production domain (styrbyapp.com) with secure flag enabled.
 */
function buildAuthCookies() {
  const cookieBaseName = `sb-${projectRef}-auth-token`;
  const sessionPayload = JSON.stringify({
    access_token: authData.access_token,
    refresh_token: authData.refresh_token,
    expires_in: authData.expires_in,
    expires_at: authData.expires_at,
    token_type: authData.token_type,
    user: authData.user,
  });

  const CHUNK_SIZE = 3500;
  const chunks = [];
  for (let i = 0; i < sessionPayload.length; i += CHUNK_SIZE) {
    chunks.push(sessionPayload.slice(i, i + CHUNK_SIZE));
  }

  const cookies = [];
  if (chunks.length === 1) {
    cookies.push({
      name: cookieBaseName,
      value: chunks[0],
      domain: '.styrbyapp.com',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    });
  } else {
    for (let i = 0; i < chunks.length; i++) {
      cookies.push({
        name: `${cookieBaseName}.${i}`,
        value: chunks[i],
        domain: '.styrbyapp.com',
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      });
    }
  }
  return cookies;
}

/**
 * Dismiss the cookie consent banner if it appears.
 */
async function dismissCookieBanner(page) {
  try {
    // Look for the dismiss/close button on the cookie banner
    const closeBtn = await page.$('button:has-text("X"), button:has-text("Accept"), button:has-text("Dismiss"), button[aria-label="Close"]');
    if (closeBtn) {
      await closeBtn.click();
      await page.waitForTimeout(500);
    }
    // Also try clicking any "X" button in the cookie area
    const xBtn = await page.$('.fixed button, [role="dialog"] button');
    if (xBtn) {
      const text = await xBtn.textContent();
      if (text && text.trim().length <= 3) {
        await xBtn.click();
        await page.waitForTimeout(500);
      }
    }
  } catch {
    // Cookie banner not found, that's fine
  }
}

/**
 * Set cookie consent in localStorage to prevent the banner from appearing.
 */
async function setCookieConsent(page) {
  await page.evaluate(() => {
    // Common cookie consent keys
    localStorage.setItem('cookie-consent', 'accepted');
    localStorage.setItem('cookieConsent', 'accepted');
    localStorage.setItem('cookie_consent', 'true');
    localStorage.setItem('cookies-accepted', 'true');
    localStorage.setItem('styrby-cookie-consent', 'accepted');
  });
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const authCookies = buildAuthCookies();
  console.log(`Auth cookies prepared: ${authCookies.length} chunk(s)`);
  console.log(`Base URL: ${BASE_URL}`);

  // ---- Desktop screenshots (1440x900) ----
  const desktopCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });

  await desktopCtx.addCookies(authCookies);
  const page = await desktopCtx.newPage();

  // Pre-set cookie consent
  await page.goto(BASE_URL);
  await setCookieConsent(page);

  // 1. Dashboard Overview
  console.log('1. Dashboard Overview...');
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await dismissCookieBanner(page);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/dashboard-overview.png`, fullPage: false });
  console.log('   Saved dashboard-overview.png');

  // 2. Cost Analytics
  console.log('2. Cost Analytics...');
  await page.goto(`${BASE_URL}/dashboard/costs`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await dismissCookieBanner(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/cost-analytics.png`, fullPage: false });
  console.log('   Saved cost-analytics.png');

  // 3. Sessions View
  console.log('3. Sessions View...');
  await page.goto(`${BASE_URL}/dashboard/sessions`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await dismissCookieBanner(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/session-view.png`, fullPage: false });
  console.log('   Saved session-view.png');

  // 4. Agents Page
  console.log('4. Agents Page...');
  await page.goto(`${BASE_URL}/dashboard/agents`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await dismissCookieBanner(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/agents-page.png`, fullPage: false });
  console.log('   Saved agents-page.png');

  await desktopCtx.close();

  // ---- Mobile screenshots (390x844) ----
  const mobileCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    colorScheme: 'dark',
  });

  await mobileCtx.addCookies(authCookies);
  const mobilePage = await mobileCtx.newPage();

  await mobilePage.goto(BASE_URL);
  await setCookieConsent(mobilePage);

  // 5. Mobile Dashboard
  console.log('5. Mobile Dashboard...');
  await mobilePage.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' });
  await mobilePage.waitForTimeout(2000);
  await dismissCookieBanner(mobilePage);
  await mobilePage.waitForTimeout(1000);
  await mobilePage.screenshot({ path: `${SCREENSHOT_DIR}/mobile-dashboard.png`, fullPage: false });
  console.log('   Saved mobile-dashboard.png');

  // 6. Mobile Costs
  console.log('6. Mobile Costs...');
  await mobilePage.goto(`${BASE_URL}/dashboard/costs`, { waitUntil: 'networkidle' });
  await mobilePage.waitForTimeout(3000);
  await dismissCookieBanner(mobilePage);
  await mobilePage.waitForTimeout(500);
  await mobilePage.screenshot({ path: `${SCREENSHOT_DIR}/mobile-costs.png`, fullPage: false });
  console.log('   Saved mobile-costs.png');

  await mobileCtx.close();
  await browser.close();
  console.log('\nAll 6 screenshots captured!');
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
