import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

// Uses a clean, disposable profile. No user browser cookies or production access.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
context.setDefaultTimeout(10_000);
const page = await context.newPage();
const errors = [];
const checks = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS:', name); };
const base = process.env.DEMO_URL || 'http://127.0.0.1:4317';
const motionOnly = process.argv.includes('--motion-only');
const welcomeHeading = page.getByRole('heading', { name: /欢迎使用/ });
const screenshots = ['welcome-desktop.png', 'desktop-connected.png', 'dropdown-open.png', 'authorization.png', 'mobile-connected.png', 'compact-form-dropdown.png', 'welcome-compact.png', 'welcome-square.png', 'welcome-mobile.png'];
await mkdir('output', { recursive: true });
async function login({ sameTab = false, cancel = false, targetPage = page } = {}) {
  const fromWelcome = await targetPage.getByRole('heading', { name: /欢迎使用/ }).isVisible();
  if (!fromWelcome) await targetPage.getByRole('button', { name: /^(登录 Conpera|重新连接账户)$/ }).click();
  const popupPromise = targetPage.waitForEvent('popup');
  await targetPage.getByRole('button', { name: fromWelcome ? '登录 Conpera' : '在浏览器中继续', exact: true }).click();
  const popup = await popupPromise;
  await popup.getByRole('button', { name: '允许连接', exact: true }).waitFor();
  if (cancel) {
    await popup.getByRole('button', { name: '取消', exact: true }).click();
    await targetPage.getByText('你已取消连接。', { exact: true }).waitFor();
    if (!fromWelcome) {
      await targetPage.getByRole('button', { name: '关闭弹窗' }).click();
      await targetPage.locator('dialog[open]').waitFor({ state: 'hidden' });
    }
    return;
  }
  if (sameTab) {
    await targetPage.getByRole('button', { name: fromWelcome ? '在此继续' : '授权窗口未出现？在此继续', exact: true }).click();
    await targetPage.getByRole('button', { name: '允许连接', exact: true }).waitFor();
    await targetPage.screenshot({ path: 'output/authorization.png', fullPage: true });
    await targetPage.getByRole('button', { name: '允许连接', exact: true }).click();
  } else await popup.getByRole('button', { name: '允许连接', exact: true }).click();
  await targetPage.getByRole('button', { name: '刷新余额', exact: true }).waitFor();
  await targetPage.getByText('128.50', { exact: false }).waitFor();
}
try {
  if (!motionOnly) {
  await page.goto(base);
  await welcomeHeading.waitFor();
  await page.getByRole('button', { name: '登录 Conpera', exact: true }).waitFor();
  await page.screenshot({ path: 'output/welcome-desktop.png', fullPage: true });
  check('First visit starts with the conpera switch welcome screen', (await welcomeHeading.innerText()).includes('conpera switch') && await page.getByRole('button', { name: '登录 Conpera', exact: true }).isVisible());
  const removedWelcomeCopy = /YOUR IDEAS|ONE CONNECTION|暂不登录|演示账户|无需密码|让灵感|专注创造/;
  check('Welcome removes decorative artwork, slogans, guest entry, and demo footnote', !removedWelcomeCopy.test(await page.locator('.welcome-screen').innerText()) && await page.locator('.welcome-visual, .welcome-orbit, .welcome-monogram, .welcome-skip').count() === 0);
  check('Ready welcome presents only the login action', await page.locator('.welcome-screen button').count() === 1);
  check('Reduced motion suppresses sustained welcome animation', await page.locator('.welcome-screen').evaluate(el => el.getAnimations({ subtree: true }).every(animation => Number(animation.effect?.getTiming().duration || 0) <= 50)));
  await login({ cancel: true });
  check('Cancelling first login leaves the welcome screen usable', await welcomeHeading.isVisible() && await page.getByRole('button', { name: '登录 Conpera', exact: true }).isEnabled() && (await page.request.get(`${base}/api/demo/balance`)).status() === 401);
  await login();
  check('Welcome login opens the authenticated dashboard', await welcomeHeading.count() === 0 && await page.getByText('creator@example.test', { exact: true }).isVisible());
  await page.reload();
  await page.getByRole('button', { name: '刷新余额', exact: true }).waitFor();
  check('Existing authenticated session skips welcome on reload', await welcomeHeading.count() === 0);
  check('Authenticated dashboard allows local controls', await page.getByRole('button', { name: '全部启用 Conpera' }).isEnabled());
  await page.getByRole('button', { name: '全部启用 Conpera' }).click();
  await page.getByRole('button', { name: '全部恢复原机' }).waitFor();
  check('Both tools switch together', await page.locator('.tool-card.is-active').count() === 2);
  const channel = page.getByRole('combobox', { name: 'Codex 渠道', exact: true });
  await channel.press('ArrowDown');
  await channel.press('End');
  await channel.press('Enter');
  check('Channel changes preserve the current key', (await page.getByRole('combobox', { name: 'Codex 密钥', exact: true }).innerText()).includes('8f2a'));
  check('Keyboard choice closes menu and restores focus', await channel.getAttribute('aria-expanded') === 'false' && await channel.evaluate(el => document.activeElement === el));
  await channel.click();
  await page.keyboard.press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  check('Escape dismisses a pointer-opened channel menu', await page.getByRole('listbox').count() === 0 && await channel.evaluate(el => document.activeElement === el));
  await channel.click();
  await page.getByRole('heading', { name: 'Claude Code', exact: true }).click();
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  check('Outside click dismisses channel menu', await page.getByRole('listbox').count() === 0);
  await channel.press('ArrowDown');
  await channel.press('Tab');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  check('Tab dismisses menu and moves focus', await page.getByRole('listbox').count() === 0 && !(await channel.evaluate(el => document.activeElement === el)));
  await page.getByRole('button', { name: '管理 Codex 密钥' }).click();
  await page.getByLabel('名称', { exact: true }).fill('我的 Demo 项目');
  const newChannel = page.getByRole('combobox', { name: '新密钥渠道', exact: true });
  await newChannel.click();
  await page.keyboard.press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  check('Escape in form select preserves the dialog', await page.locator('dialog[open]').count() === 1 && await page.getByRole('listbox').count() === 0);
  await newChannel.click();
  await page.getByRole('option', { name: '优先渠道', exact: true }).click();
  await page.getByRole('button', { name: '添加并选择', exact: true }).click();
  check('New demo key selected', (await page.locator('.key-item.chosen').innerText()).includes('我的 Demo 项目'));
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  check('Modal keyboard dismissal', await page.locator('dialog[open]').count() === 0);
  await page.getByRole('button', { name: '全部恢复原机' }).click();
  await page.getByRole('button', { name: '全部启用 Conpera' }).waitFor();
  check('Restore both original modes', await page.locator('.tool-card.is-active').count() === 0);
  await page.getByLabel('账户选项', { exact: true }).click();
  await page.getByRole('button', { name: '模拟登录过期' }).click();
  await page.getByRole('button', { name: '重新连接账户' }).waitFor();
  await login({ cancel: true });
  check('Cancelling reconnection preserves the expired dashboard', await page.getByRole('button', { name: '重新连接账户' }).isVisible() && (await page.request.get(`${base}/api/demo/balance`)).status() === 401);
  await login();
  check('Popup login shows authenticated demo balance', await page.getByText('creator@example.test', { exact: true }).isVisible());
  await page.reload();
  await page.getByRole('button', { name: '刷新余额', exact: true }).waitFor();
  check('HttpOnly login survives reload', await page.getByText('creator@example.test', { exact: true }).isVisible());
  const cookie = (await context.cookies()).find(c => c.name === 'conpera_demo_session');
  check('Session cookie has expected scope', cookie?.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/api/demo');
  await page.getByRole('button', { name: '全部启用 Conpera' }).click();
  await page.getByRole('button', { name: '全部恢复原机' }).waitFor();
  await page.getByRole('button', { name: '刷新余额' }).click();
  await page.locator('.toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: 'output/desktop-connected.png', fullPage: true });
  await channel.click();
  await page.screenshot({ path: 'output/dropdown-open.png', fullPage: true });
  await channel.press('Escape');
  await page.getByLabel('账户选项', { exact: true }).click();
  await page.getByRole('button', { name: '模拟登录过期' }).click();
  await page.getByRole('button', { name: '重新连接账户' }).waitFor();
  check('Expired login stays on the dashboard for reconnection', await welcomeHeading.count() === 0);
  check('Expiry preserves local tool modes', await page.locator('.tool-card.is-active').count() === 2);
  check('Expired session cannot read balance', (await page.request.get(`${base}/api/demo/balance`)).status() === 401);
  await login({ sameTab: true });
  check('Same-tab fallback completes login', await page.getByText('creator@example.test', { exact: true }).isVisible());
  check('PKCE fallback removed after exchange', await page.evaluate(() => sessionStorage.getItem('conpera-switch-demo:pending-authorization')) === null);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/mobile-connected.png', fullPage: true });
  check('Mobile has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1040, height: 760 });
  check('Compact desktop has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1000, height: 460 });
  await page.getByRole('button', { name: '管理 Codex 密钥' }).click();
  const compactChannel = page.getByRole('combobox', { name: '新密钥渠道', exact: true });
  await compactChannel.click();
  const compactMenu = page.getByRole('listbox', { name: '新密钥渠道', exact: true });
  await compactMenu.waitFor({ state: 'visible' });
  // Capture the actual Mac-sized viewport, including the dialog's scroll boundary.
  await page.screenshot({ path: 'output/compact-form-dropdown.png' });
  const menuBounds = await compactMenu.boundingBox();
  const dialogBounds = await page.locator('dialog[open]').boundingBox();
  const menuReceivesPointer = await compactMenu.evaluate(el => {
    const bounds = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  });
  check('Form dropdown fits and remains visible in the compact Mac dialog', await compactChannel.getAttribute('aria-expanded') === 'true' && await compactMenu.isVisible() && menuReceivesPointer && menuBounds && dialogBounds && menuBounds.width > 0 && menuBounds.height > 0 && menuBounds.y >= dialogBounds.y && menuBounds.y + menuBounds.height <= Math.min(dialogBounds.y + dialogBounds.height, 460));
  await page.keyboard.press('Escape');
  await compactMenu.waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await welcomeHeading.waitFor();
  check('Logout returns to welcome and revokes the session', await page.getByRole('button', { name: '登录 Conpera', exact: true }).isVisible() && (await page.request.get(`${base}/api/demo/balance`)).status() === 401);
  await page.reload();
  await welcomeHeading.waitFor();
  check('Logged-out welcome state survives reload', await page.getByRole('button', { name: '刷新余额', exact: true }).count() === 0);
  await login();
  check('Local modes survive logout and subsequent login', await page.locator('.tool-card.is-active').count() === 2 && await page.getByRole('button', { name: '刷新余额', exact: true }).isVisible());
  }

  const motionContext = await browser.newContext({ viewport: { width: 1000, height: 460 }, reducedMotion: 'no-preference' });
  motionContext.setDefaultTimeout(10_000);
  const motionPage = await motionContext.newPage();
  motionPage.on('pageerror', error => errors.push(error.message));
  await motionPage.goto(base);
  await motionPage.getByRole('heading', { name: /欢迎使用/ }).waitFor();
  check('Welcome animates when motion is enabled', await motionPage.locator('.welcome-screen').evaluate(el => el.getAnimations({ subtree: true }).some(animation => Number(animation.effect?.getTiming().duration || 0) >= 120)));
  async function verifyWelcomeViewport(name, file) {
    await motionPage.evaluate(() => Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)));
    const visibleControls = await motionPage.locator('.welcome-primary').evaluateAll(elements => elements.length === 1 && elements.every(el => {
      const bounds = el.getBoundingClientRect();
      let visible = true;
      for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (Number(style.opacity) < .99 || style.visibility === 'hidden' || style.display === 'none') visible = false;
      }
      return visible && bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
    }));
    const square = await motionPage.locator('.welcome-screen').boundingBox();
    check(`${name} welcome is square with its login action fully visible`, square && Math.abs(square.width - square.height) <= 1 && visibleControls && await motionPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await motionPage.screenshot({ path: `output/${file}`, fullPage: true });
  }
  await verifyWelcomeViewport('Compact Mac', 'welcome-compact.png');
  await motionPage.setViewportSize({ width: 540, height: 540 });
  await verifyWelcomeViewport('Square window', 'welcome-square.png');
  await motionPage.setViewportSize({ width: 390, height: 844 });
  await verifyWelcomeViewport('Mobile', 'welcome-mobile.png');
  await motionPage.setViewportSize({ width: 1000, height: 460 });
  await login({ targetPage: motionPage });
  const motionCard = motionPage.getByTestId('tool-codex');
  const thumb = motionCard.locator('.switch-thumb');
  await thumb.waitFor();
  const initialThumb = await thumb.boundingBox();
  await thumb.evaluate(el => {
    window.__switchMotionObserved = false;
    el.addEventListener('transitionrun', event => {
      if (event.propertyName === 'transform' || event.propertyName === 'translate' || event.propertyName === 'left') window.__switchMotionObserved = true;
    });
  });
  await motionCard.getByRole('button', { name: 'Conpera', exact: true }).click();
  await motionPage.waitForFunction(() => window.__switchMotionObserved === true);
  await thumb.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
  const finalThumb = await thumb.boundingBox();
  check('Switch visibly slides to the selected mode', initialThumb && finalThumb && finalThumb.x > initialThumb.x + initialThumb.width / 2 && await motionCard.getByRole('button', { name: 'Conpera', exact: true }).getAttribute('aria-pressed') === 'true');
  await motionPage.getByRole('button', { name: '管理 Codex 密钥' }).click();
  const motionDialog = motionPage.locator('dialog[open]');
  await motionDialog.waitFor();
  await motionPage.getByRole('button', { name: '关闭弹窗' }).click();
  await motionDialog.waitFor({ state: 'hidden' });
  check('Animated dialog dismissal returns control to the dashboard', await motionPage.getByRole('button', { name: '管理 Codex 密钥' }).isEnabled());
  await motionContext.close();
  check('No browser runtime exceptions', errors.length === 0);
  console.log(JSON.stringify({ result: 'passed', checks, screenshots: motionOnly ? screenshots.filter(file => file === 'welcome-compact.png' || file === 'welcome-square.png' || file === 'welcome-mobile.png') : screenshots }, null, 2));
} finally { await browser.close(); }
