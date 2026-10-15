import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Disposable profiles and intercepted session data; no production account access.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const base = process.env.DEMO_URL || 'http://127.0.0.1:4317';
const session = {
  user: { name: 'Startup regression', email: 'startup@example.test' },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
const connectedResponse = { status: 200, contentType: 'application/json', body: JSON.stringify(session) };

async function verifyStartupFocusRace(connected) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();
  let focusRequested = false;
  let focusReads = 0;
  const pending = [];
  let firstRequestStarted;
  const firstRequest = new Promise(resolve => { firstRequestStarted = resolve; });

  await page.route('**/api/demo/session', async route => {
    if (!focusRequested) {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      pending.push({ release, request: route.request() });
      firstRequestStarted();
      await gate;
      // A late initial response must not overwrite the newer focus result.
      await route.fulfill(connected ? { status: 401, body: 'expired' } : connectedResponse);
      return;
    }
    focusReads++;
    await route.fulfill(connected ? connectedResponse : { status: 503, body: 'unavailable' });
  });
  await page.route('**/api/demo/balance', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ balance: 128.5, updatedAt: new Date().toISOString() }),
  }));

  try {
    await page.goto(base);
    await firstRequest;
    await page.locator('.startup-screen').waitFor();
    focusRequested = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    if (connected) {
      await page.getByRole('button', { name: '刷新余额', exact: true }).waitFor();
      assert.equal(await page.locator('.welcome-screen').count(), 0, 'An existing session skips welcome');
    } else {
      await page.getByRole('heading', { name: /欢迎使用/ }).waitFor();
      await page.getByRole('button', { name: '登录 Conpera', exact: true }).waitFor();
      assert.ok(await page.getByRole('button', { name: '登录 Conpera', exact: true }).isEnabled(), 'Offline welcome permits another connection attempt');
    }
    assert.ok(focusReads >= 1, 'The focus revalidation completed while initial reads remained pending');

    const responses = pending.map(({ request }) => page.waitForResponse(response => response.request() === request));
    pending.forEach(({ release }) => release());
    await Promise.all(responses);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.startup-screen').count(), 0, 'Startup cannot remain stuck after revalidation');
    if (connected) {
      assert.equal(await page.getByRole('button', { name: '刷新余额', exact: true }).count(), 1, 'Late initial expiry cannot replace the connected session');
    } else {
      assert.equal(await page.getByRole('heading', { name: /欢迎使用/ }).count(), 1, 'Late initial success cannot replace the latest offline welcome state');
      assert.ok(await page.getByRole('button', { name: '登录 Conpera', exact: true }).isEnabled(), 'Offline welcome remains usable after the late response');
      assert.equal(await page.getByRole('button', { name: '刷新余额', exact: true }).count(), 0, 'Offline startup cannot open the authenticated dashboard');
    }
    console.log(`PASS: startup focus race ${connected ? 'preserves the connected session' : 'recovers from service failure'}`);
  } finally {
    pending.forEach(({ release }) => release());
    await context.close();
  }
}

try {
  await verifyStartupFocusRace(true);
  await verifyStartupFocusRace(false);
} finally {
  await browser.close();
}
