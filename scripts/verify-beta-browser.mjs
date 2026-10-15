import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Serves a frozen local build and substitutes only the native Promise bridge.
// No cookies, credentials, user browser profile, CLI configuration, or production
// endpoints are read. All non-fixture network requests are blocked and fail QA.
const release = process.argv.includes('--release');
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const reportName = release ? 'release-browser-report.json' : 'beta-browser-report.json';
const project = fileURLToPath(new URL('..', import.meta.url));
await access(join(project, 'dist/index.html'));
const scratch = await mkdtemp(join(tmpdir(), 'conpera-beta-browser-'));
const staticRoot = join(scratch, 'web');
const output = join(project, 'output');
const checks = [];
const errors = [];
const blocked = [];
const httpRequests = [];
let browser;
let server;
const check = (label, condition) => {
  assert.ok(condition, label);
  checks.push(label);
  console.log(`PASS: ${label}`);
};

try {
  await cp(join(project, 'dist'), staticRoot, { recursive: true });
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
  server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://fixture.invalid').pathname);
      httpRequests.push(path);
      const file = resolve(staticRoot, path === '/' ? 'index.html' : `.${path}`);
      if (!file.startsWith(staticRoot + sep)) { response.writeHead(403).end(); return; }
      const bytes = await readFile(file);
      response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 600 }, reducedMotion: 'reduce', userAgent: (release ? `ConperaSwitchMac/${version} ConperaSwitchNative/${version}` : 'ConperaSwitchMac/0.2 ConperaSwitchBeta/0.2') });
  context.setDefaultTimeout(10_000);
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin === origin) await route.continue();
    else { blocked.push(route.request().url()); await route.abort('blockedbyclient'); }
  });
  await context.addInitScript(() => {
    const clone = value => JSON.parse(JSON.stringify(value));
    const fixture = {
      connected: false,
      denyLogin: true,
      balance: 42.75,
      currency: 'CNY',
      failApply: {},
      failChannel: false,
      channelTimeoutAfterWrite: false,
      failRestore: {},
      failKeys: false,
      failStatus: false,
      sessionDenied: false,
      logoutFailure: '',
      calls: [],
      layouts: [],
      storageWrites: [],
      tools: { codex: { mode: 'original' }, claude: { mode: 'original' } },
      user: { id: 'test-fixture-77', name: 'Test Browser', email: 'test77@example.invalid' },
      keys: [
        { id: 'server-codex-101', tool: 'codex', name: '测试 Codex 主密钥', channel: '账户标准渠道', suffix: 'aa01' },
        { id: 'server-codex-102', tool: 'codex', name: '测试 Codex 备用密钥', channel: '账户备用渠道', suffix: 'bb02' },
        { id: 'server-codex-103', tool: 'codex', name: '测试 Codex 同渠道密钥', channel: '账户标准渠道', suffix: 'dd03' },
        { id: 'server-codex-104', tool: 'codex', name: '实验密钥', channel: '内部测试-实验渠道', suffix: 'ee04' },
        { id: 'server-claude-201', tool: 'claude', name: '测试 Claude 密钥', channel: '账户 Claude 渠道', suffix: 'cc03' },
      ],
    };
    fixture.keys.forEach((key,index)=>key.channelId = `group:${[1,2,1,3,4][index]}`);
    fixture.channels = [...new Map(fixture.keys.map(key => [key.channelId, { id:key.channelId, name:key.channel, tool:key.tool }])).values(),
      { id:'group:28', name:'Claude code Max 老号分组（不降智测试）', tool:'claude' }];
    const scenario = new URL(location.href).searchParams.get('fixture');
    if (scenario === 'saved-internal') {
      fixture.connected = true;
      fixture.tools.codex = { mode: 'conpera', keyId: 'server-codex-104' };
    }
    if (scenario === 'long-labels') {
      fixture.connected = true;
      fixture.keys[0].name = '设备专用密钥'.repeat(18);
      fixture.keys[0].channel = 'Codex GPT Pro 尊享自营长名称渠道'.repeat(5);
      fixture.channels[0].name = fixture.keys[0].channel;
    }
    if (scenario === 'keys-failed') {
      fixture.connected = true;
      fixture.failKeys = true;
      fixture.tools.codex = { mode: 'conpera', keyId: 'server-codex-101' };
    }
    if (scenario === 'status-failed') {
      fixture.connected = true;
      fixture.failStatus = true;
      fixture.tools.codex = { mode: 'conpera', keyId: 'server-codex-101' };
    }
    if (scenario === 'session-denied') {
      fixture.connected = true;
      fixture.sessionDenied = true;
    }
    window.__betaFixture = fixture;
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      fixture.storageWrites.push({ key: String(key), value: String(value) });
      return originalSet.call(this, key, value);
    };
    const okay = data => ({ ok: true, data: clone(data) });
    const failure = (status, code, message) => ({ ok: false, error: { status, code, message } });
    const session = () => ({ user: fixture.user, expiresAt: '2099-01-01T00:00:00Z' });
    const status = () => ({ tools: fixture.tools, restartRequired: true });
    window.webkit = { messageHandlers: {
      windowLayout: { postMessage: value => fixture.layouts.push(value) },
      switch: { postMessage: async request => {
        fixture.calls.push(clone(request));
        const { action, payload } = request;
        if (!payload || typeof payload !== 'object') return failure(400, 'invalid_request', '无效请求');
        if (action === 'status') return fixture.failStatus ? failure(409, 'configuration_unavailable', '无法安全读取本机配置，未确认当前配置来源。') : okay(status());
        if (action === 'cancelLogin') return okay({});
        if (action === 'restore') {
          await new Promise(resolve => setTimeout(resolve, 15));
          if (fixture.failRestore[payload.tool]) return failure(409, 'configuration_changed', '配置已被其他程序修改，原机备份已保留。');
          fixture.tools[payload.tool] = { mode: 'original' };
          return okay(status());
        }
        if (action === 'login') {
          if (fixture.denyLogin) return failure(403, 'beta_access_denied', '内测目前仅向 test 用户和 admin 管理员开放。');
          fixture.connected = true;
          return okay(session());
        }
        if (action === 'logout') {
          if (fixture.logoutFailure === 'keychain_error') return failure(500, 'keychain_error', '无法清除钥匙串，退出未完成，请重试。');
          fixture.connected = false;
          if (fixture.logoutFailure === 'logout_remote_unconfirmed') return failure(503, 'logout_remote_unconfirmed', '本机已退出，远端撤销未确认。');
          return okay({ revoked: true });
        }
        if (!fixture.connected) return failure(401, 'unauthenticated', '请重新登录。');
        if (action === 'session') return fixture.sessionDenied ? failure(403, 'beta_access_denied', '当前账户没有内测权限，仅向 test 用户和 admin 管理员开放。') : okay(session());
        if (action === 'balance') return okay({ balance: fixture.balance, ...(fixture.currency ? { currency: fixture.currency } : {}), updatedAt: '2026-10-08T00:00:00Z' });
        if (action === 'keys') return fixture.failKeys ? failure(503, 'keys_unavailable', '暂时无法同步账户密钥。') : okay({ keys: fixture.keys, channels: fixture.channels });
        if (action === 'changeChannel') {
          await new Promise(resolve => setTimeout(resolve, 15));
          if (fixture.failChannel) return failure(409, 'switch_channel_unavailable', '此渠道暂不可用。');
          const key=fixture.keys.find(key=>key.id===payload.keyId && key.tool===payload.tool);
          const channel=fixture.channels.find(channel=>channel.id===payload.channelId && channel.tool===payload.tool);
          if(!key || !channel || key.channelId!==payload.expectedChannelId) return failure(409,'switch_channel_changed','密钥渠道已变化。');
          key.channelId=channel.id;key.channel=channel.name;
          if(fixture.channelTimeoutAfterWrite) return failure(503,'network_error','未能确认切换结果。');
          return okay({key});
        }
        if (action === 'apply') {
          await new Promise(resolve => setTimeout(resolve, 15));
          if (fixture.failApply[payload.tool]) return failure(507, 'configuration_write_failed', '磁盘写入失败，未修改配置。');
          if (fixture.tools[payload.tool]?.mode === 'conflict') return failure(409, 'configuration_changed', '配置存在冲突，未作修改。');
          if (!fixture.keys.some(key => key.tool === payload.tool && key.id === payload.keyId)) return failure(403, 'invalid_key', '密钥与工具不匹配。');
          fixture.tools[payload.tool] = { mode: 'conpera', keyId: payload.keyId };
          return okay(status());
        }
        return failure(400, 'unsupported_action', '不支持的操作。');
      } },
    } };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const welcome = page.getByRole('heading', { name: /欢迎使用/ });
  const codex = page.getByTestId('tool-codex');
  const claude = page.getByTestId('tool-claude');
  const codexKeys = page.getByRole('combobox', { name: 'Codex 渠道', exact: true });
  const calls = action => page.evaluate(action => window.__betaFixture.calls.filter(call => call.action === action), action);
  async function assertStorage(label, targetPage = page) {
    const value = await targetPage.evaluate(() => ({
      local: Object.fromEntries(Object.entries(localStorage)),
      session: Object.fromEntries(Object.entries(sessionStorage)),
      writes: window.__betaFixture.storageWrites,
    }));
    check(label, !/access.?token|refresh.?token|api.?key|code.?verifier|synthetic-key-for-local-tests/i.test(JSON.stringify(value)) && Object.keys(value.local).length === 0 && Object.keys(value.session).length === 0);
  }
  async function login() {
    await page.getByRole('button', { name: '登录 Conpera', exact: true }).click();
    await page.getByRole('button', { name: '刷新余额', exact: true }).waitFor();
    await codexKeys.waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Codex 渠道"]')?.textContent.includes('账户标准渠道'));
  }
  async function waitIdle(card) {
    await card.locator('[aria-label="Conpera"]').waitFor();
    await page.waitForFunction(testId => document.querySelector(`[data-testid="${testId}"]`)?.getAttribute('aria-busy') === 'false', await card.getAttribute('data-testid'));
  }

  await page.goto(origin);
  await welcome.waitFor();
  check('Beta welcome renders without demo branding or guest fallback', await page.getByText(release ? version : 'BETA', { exact: true }).isVisible() && !/DEMO|演示账户|无需密码|暂不登录/.test(await page.locator('body').innerText()));
  await assertStorage('Startup persists no account credentials or demo preferences');
  await page.getByRole('button', { name: '登录 Conpera', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '仅向 test 用户和 admin' }).waitFor();
  check('403 beta denial remains on the usable login screen', await welcome.isVisible() && await page.getByRole('button', { name: '登录 Conpera', exact: true }).isEnabled() && await codex.count() === 0);
  check('Denied login never requests balance or key metadata', (await calls('balance')).length === 0 && (await calls('keys')).length === 0);
  await page.evaluate(() => { window.__betaFixture.denyLogin = false; });
  await login();
  await page.waitForFunction(() => document.querySelector('.balance-value')?.textContent === '42.75');
  check('Successful native login renders authenticated account and balance', await page.getByText('test77@example.invalid', { exact: true }).isVisible() && await welcome.count() === 0);
  check('CNY balance displays the explicit yuan symbol', await page.locator('.currency').innerText() === '¥' && await page.locator('.currency').getAttribute('aria-label') === 'CNY');
  check('CNY balance has a matching accessible currency label', await page.locator('.balance-value').getAttribute('aria-label') === '余额 42.75 元');
  await page.evaluate(() => { window.__betaFixture.currency = 'USD'; window.__betaFixture.balance = -12.34; });
  await page.getByRole('button', { name: '刷新余额', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.balance-value')?.textContent === '-12.34');
  check('USD balance displays dollars and preserves a negative amount', await page.locator('.currency').innerText() === '$' && await page.locator('.currency').getAttribute('aria-label') === 'USD' && await page.locator('.balance-value').innerText() === '-12.34');
  check('USD accessible balance preserves the amount and identifies dollars', await page.locator('.balance-value').getAttribute('aria-label') === '余额 -12.34 美元');
  await page.evaluate(() => { window.__betaFixture.currency = null; window.__betaFixture.balance = 42.75; });
  await page.getByRole('button', { name: '刷新余额', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.balance-value')?.textContent === '42.75' && document.querySelector('.currency')?.textContent === '');
  check('Missing currency does not silently default a beta balance to yuan', await page.locator('.currency').getAttribute('aria-label') === null);
  check('Missing currency is not guessed by the accessible balance label', await page.locator('.balance-value').getAttribute('aria-label') === '余额 42.75');
  await page.evaluate(() => { window.__betaFixture.currency = 'CNY'; });
  await page.getByRole('button', { name: '刷新余额', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.currency')?.textContent === '¥');
  const dashboardText = await page.locator('body').innerText();
  check('Dashboard uses only native metadata and no fixed demo rows or balance', dashboardText.includes('账户标准渠道') && dashboardText.includes('测试 Codex 主密钥') && dashboardText.includes('账户 Claude 渠道') && dashboardText.includes('测试 Claude 密钥') && !/Conpera Creator|creator@example\.test|128\.50|8f2a|6a1f|DEMO/.test(dashboardText));
  await page.getByRole('button', { name: '管理 Codex 密钥', exact: true }).click();
  await page.getByRole('heading', { name: 'Codex · 密钥', exact: true }).waitFor();
  check('Beta key management contains synced metadata and no local fake-key creation', await page.locator('.key-item').count() === 4 && await page.getByRole('button', { name: '添加并选择', exact: true }).count() === 0 && await page.getByRole('textbox').count() === 0);
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  const beforeChannelChoices = (await calls('apply')).length;
  await codexKeys.click();
  check('Channel list deduplicates multiple keys and hides internal channels', await page.getByRole('option').count() === 2 && await page.getByRole('option', { name: '账户标准渠道', exact: true }).count() === 1 && await page.getByRole('option', { name: '内部测试-实验渠道', exact: true }).count() === 0);
  await page.keyboard.press('Escape');
  const keyChoice = page.getByRole('combobox', { name: 'Codex 密钥', exact: true });
  await keyChoice.click();
  check('Key list allows selecting any owned key of the tool independently of channel', await page.getByRole('option').count() === 4);
  await page.getByRole('option', { name: '测试 Codex 同渠道密钥 · dd03', exact: true }).click();
  check('Choosing a key in original mode does not write local configuration', (await keyChoice.innerText()).includes('dd03') && (await calls('apply')).length === beforeChannelChoices);
  await page.getByRole('button', { name: 'Codex 高级选项', exact: true }).click();
  await page.getByRole('combobox', { name: 'Codex 内部测试渠道', exact: true }).click();
  await page.getByRole('option', { name: '内部测试-实验渠道', exact: true }).click();
  await waitIdle(codex);
  check('Advanced channel changes the currently selected key without replacing it', (await codexKeys.innerText()).includes('内部测试-实验渠道') && (await keyChoice.innerText()).includes('dd03') && (await calls('changeChannel')).at(-1).payload.keyId === 'server-codex-103');
  await codexKeys.click();
  await page.getByRole('option', { name: '账户标准渠道', exact: true }).click();
  await waitIdle(codex);
  check('Returning to a normal channel preserves the current key', (await keyChoice.innerText()).includes('dd03') && (await calls('apply')).length === beforeChannelChoices);
  const beforeSame = (await calls('changeChannel')).length;
  await codexKeys.click();await page.getByRole('option', { name:'账户标准渠道', exact:true }).click();
  check('Reselecting current channel does not mutate it', (await calls('changeChannel')).length === beforeSame);
  const claudeChannel=page.getByRole('combobox',{name:'Claude Code 渠道',exact:true});
  await claudeChannel.click();
  check('Old-account Claude channel without existing keys is visible in the normal list', await page.getByRole('option',{name:'Claude code Max 老号分组（不降智测试）',exact:true}).isVisible());
  await page.getByRole('option',{name:'Claude code Max 老号分组（不降智测试）',exact:true}).click();await waitIdle(claude);
  check('Old-account choice moves the same Claude key and never creates or applies another key', (await page.getByRole('combobox',{name:'Claude Code 密钥',exact:true}).innerText()).includes('cc03') && (await calls('changeChannel')).at(-1).payload.keyId==='server-claude-201' && (await calls('apply')).length===beforeChannelChoices);
  await page.evaluate(()=>{window.__betaFixture.failChannel=true});
  await claudeChannel.click();await page.getByRole('option',{name:'账户 Claude 渠道',exact:true}).click();await waitIdle(claude);
  check('Failed channel mutation retains the confirmed server channel and key', (await claudeChannel.innerText()).includes('老号') && (await page.getByRole('combobox',{name:'Claude Code 密钥',exact:true}).innerText()).includes('cc03'));
  await page.evaluate(()=>{window.__betaFixture.failChannel=false;window.__betaFixture.channelTimeoutAfterWrite=true});
  const beforeTimeout=(await calls('changeChannel')).length;
  await claudeChannel.click();await page.getByRole('option',{name:'账户 Claude 渠道',exact:true}).click();await waitIdle(claude);
  check('Ambiguous timeout reads back the changed channel without retrying the mutation', (await claudeChannel.innerText()).includes('账户 Claude 渠道') && (await calls('changeChannel')).length===beforeTimeout+1);
  await page.evaluate(()=>{window.__betaFixture.channelTimeoutAfterWrite=false});
  await keyChoice.click();await page.getByRole('option',{name:'测试 Codex 备用密钥 · bb02',exact:true}).click();

  await page.evaluate(() => { window.__betaFixture.failApply.codex = true; });
  await codex.getByRole('button', { name: 'Conpera', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '磁盘写入失败' }).waitFor();
  await waitIdle(codex);
  check('A failed native write leaves original mode selected with no success toast', await codex.getByRole('button', { name: '原机配置', exact: true }).getAttribute('aria-pressed') === 'true' && await codex.getByRole('button', { name: 'Conpera', exact: true }).getAttribute('aria-pressed') === 'false' && !(await page.locator('.toast').allTextContents()).some(value => value.includes('已写入')));
  check('Apply bridge receives only a tool and key identifier', (await calls('apply')).every(call => Object.keys(call.payload).sort().join(',') === 'keyId,tool') && (await calls('apply')).at(-1).payload.keyId === 'server-codex-102');
  await page.evaluate(() => { window.__betaFixture.failApply.codex = false; });
  await codex.getByRole('button', { name: 'Conpera', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="tool-codex"] [aria-label="Conpera"]')?.getAttribute('aria-pressed') === 'true');
  check('Successful write reflects native readback state and asks for restart', (await page.locator('.toast').innerText()).includes('重启') && await codex.getAttribute('class').then(value => value.includes('is-active')));

  const activeApplyCount=(await calls('apply')).length;
  await codexKeys.click();await page.getByRole('option',{name:'账户标准渠道',exact:true}).click();await waitIdle(codex);
  check('Active channel switching keeps its key and local CLI configuration', (await keyChoice.innerText()).includes('bb02') && (await calls('apply')).length===activeApplyCount);
  await page.evaluate(() => { window.__betaFixture.failApply.codex = true; });
  await keyChoice.click();await page.getByRole('option',{name:'测试 Codex 主密钥 · aa01',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'磁盘写入失败'}).waitFor();await waitIdle(codex);
  check('A failed active-key change retains the previously applied key', (await keyChoice.innerText()).includes('bb02'));
  await assertStorage('Login, key selection, and write results never persist tokens or key material');

  // Trigger a fresh account read and therefore a fresh native configuration read.
  await page.evaluate(() => {
    window.__betaFixture.failApply.codex = false;
    window.__betaFixture.tools.codex = { mode: 'conflict', keyId: 'server-codex-102' };
    window.__betaFixture.failRestore.codex = true;
    window.__betaFixture.user.email = 'test78@example.invalid';
    window.dispatchEvent(new Event('focus'));
  });
  await page.getByRole('alert').filter({ hasText: '检测到外部配置修改' }).waitFor();
  check('Conflict state is not labeled as confirmed original or Conpera', await codex.getByRole('button', { name: '原机配置', exact: true }).getAttribute('aria-pressed') === 'false' && await codex.getByRole('button', { name: 'Conpera', exact: true }).getAttribute('aria-pressed') === 'false');
  const beforeRestore = (await calls('restore')).length;
  await codex.getByRole('button', { name: '原机配置', exact: true }).click();
  await page.waitForFunction(previous => window.__betaFixture.calls.filter(call => call.action === 'restore').length > previous, beforeRestore);
  await page.getByRole('alert').filter({ hasText: '配置已被其他程序修改，原机备份已保留' }).waitFor();
  await waitIdle(codex);
  check('Conflict restore remains callable and preserves conflict after native 409', (await calls('restore')).at(-1).payload.tool === 'codex' && await codex.getByRole('button', { name: '原机配置', exact: true }).getAttribute('aria-pressed') === 'false');
  await page.evaluate(() => { window.__betaFixture.failRestore.codex = false; });
  await codex.getByRole('button', { name: '原机配置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="tool-codex"] [aria-label="原机配置"]')?.getAttribute('aria-pressed') === 'true');
  check('Resolved native restore updates the original mode', await page.getByRole('alert').filter({ hasText: '检测到外部配置修改' }).count() === 0);

  await claude.getByRole('button', { name: 'Conpera', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude"] [aria-label="Conpera"]')?.getAttribute('aria-pressed') === 'true');
  await page.getByLabel('账户选项', { exact: true }).click();
  check('Beta account menu excludes synthetic expiry controls', await page.getByRole('button', { name: '模拟登录过期', exact: true }).count() === 0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await welcome.waitFor();
  check('Logout clears visible identity, balance, and key metadata', !/test7[78]@|42\.75|测试 Codex|测试 Claude/.test(await page.locator('body').innerText()) && await page.getByRole('button', { name: '刷新余额', exact: true }).count() === 0);
  check('Logout removes the previously displayed balance currency', await page.locator('.currency').count() === 0 && !/[¥$]/.test(await page.locator('body').innerText()));
  check('Logout requests account revocation while preserving native applied configuration', (await calls('logout')).length === 1 && await page.evaluate(() => window.__betaFixture.tools.claude.mode) === 'conpera');
  await assertStorage('Logout leaves no local or session credential storage');
  await page.evaluate(() => { window.__betaFixture.currency = null; });
  await login();
  await page.waitForFunction(() => document.querySelector('.balance-value')?.textContent === '42.75');
  check('A new account read without currency does not reuse the logged-out currency', await page.locator('.currency').innerText() === '' && await page.locator('.currency').getAttribute('aria-label') === null);
  check('Reconnection reads existing native configuration instead of resetting it', await claude.getByRole('button', { name: 'Conpera', exact: true }).getAttribute('aria-pressed') === 'true');

  await page.evaluate(() => { window.__betaFixture.logoutFailure = 'keychain_error'; });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.locator('.toast').filter({ hasText: '无法清除钥匙串' }).waitFor();
  check('Keychain deletion failure preserves the authenticated UI and shows its error', await welcome.count() === 0 && await page.getByText('test78@example.invalid', { exact: true }).isVisible() && await page.getByRole('button', { name: '刷新余额', exact: true }).isVisible() && await page.evaluate(() => window.__betaFixture.connected));
  await page.evaluate(() => { window.__betaFixture.logoutFailure = 'logout_remote_unconfirmed'; });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await welcome.waitFor();
  await page.getByRole('alert').filter({ hasText: '本机已退出，远端撤销未确认。' }).waitFor();
  check('Unconfirmed remote revocation clears local UI and reports only confirmed local logout', !/test7[78]@|42\.75|测试 Codex|测试 Claude/.test(await page.locator('body').innerText()) && !await page.evaluate(() => window.__betaFixture.connected) && await page.getByRole('button', { name: '登录 Conpera', exact: true }).isEnabled());
  check('Unconfirmed remote revocation also removes local balance currency', await page.locator('.currency').count() === 0);
  await assertStorage('Both logout failure paths keep credential storage empty');

  async function scenarioPage(name) {
    const targetPage = await context.newPage();
    targetPage.on('pageerror', error => errors.push(error.message));
    await targetPage.goto(`${origin}/?fixture=${name}`);
    return targetPage;
  }
  const missingKeys = await scenarioPage('keys-failed');
  await missingKeys.getByRole('alert').filter({ hasText: '暂时无法同步账户密钥' }).waitFor();
  const missingKeysCodex = missingKeys.getByTestId('tool-codex');
  check('Failed key synchronization still adopts the independently successful native status', await missingKeysCodex.getByRole('button', { name: 'Conpera', exact: true }).getAttribute('aria-pressed') === 'true' && await missingKeysCodex.getByRole('button', { name: '原机配置', exact: true }).getAttribute('aria-pressed') === 'false');
  check('Failed key synchronization retains local restore without inventing key metadata', await missingKeysCodex.getByRole('button', { name: '原机配置', exact: true }).isEnabled() && await missingKeys.getByRole('combobox', { name: 'Codex 渠道', exact: true }).isDisabled() && !/aa01|bb02|8f2a|测试 Codex/.test(await missingKeys.locator('body').innerText()));
  await missingKeysCodex.getByRole('button', { name: '原机配置', exact: true }).click();
  await missingKeys.waitForFunction(() => document.querySelector('[data-testid="tool-codex"] [aria-label="原机配置"]')?.getAttribute('aria-pressed') === 'true');
  check('Local restoration completes despite unavailable account key service', await missingKeys.evaluate(() => window.__betaFixture.calls.some(call => call.action === 'restore' && call.payload.tool === 'codex')));
  await assertStorage('Independent status adoption never persists account credentials', missingKeys);

  const missingStatus = await scenarioPage('status-failed');
  await missingStatus.getByRole('alert').filter({ hasText: '无法安全读取本机配置' }).waitFor();
  const unknownCards = missingStatus.locator('.tool-card');
  check('Failed native status leaves both modes unselected instead of claiming original', await unknownCards.locator('[aria-pressed="true"]').count() === 0 && await unknownCards.locator('.status[title="配置未读取"]').count() === 2);
  check('Unknown status disables individual and bulk enabling while retaining recovery', await missingStatus.getByTestId('tool-codex').getByRole('button', { name: 'Conpera', exact: true }).isDisabled() && await missingStatus.getByTestId('tool-claude').getByRole('button', { name: 'Conpera', exact: true }).isDisabled() && await missingStatus.getByRole('button', { name: '全部启用 Conpera', exact: true }).isDisabled() && await missingStatus.getByTestId('tool-codex').getByRole('button', { name: '原机配置', exact: true }).isEnabled());
  const unknownKeys = missingStatus.getByRole('combobox', { name: 'Codex 渠道', exact: true });
  const unknownApplyCount = await missingStatus.evaluate(() => window.__betaFixture.calls.filter(call => call.action === 'apply').length);
  if (await unknownKeys.isEnabled()) {
    await unknownKeys.click();
    await missingStatus.getByRole('option', { name: '账户备用渠道', exact: true }).click();
  }
  await missingStatus.getByRole('button', { name: '管理 Codex 密钥', exact: true }).click();
  await missingStatus.getByRole('heading', { name: 'Codex · 密钥', exact: true }).waitFor();
  check('Available key metadata is still loaded independently of native status failure', await missingStatus.locator('.key-item').count() === 4);
  const unknownKeyRow = missingStatus.getByRole('button', { name: /测试 Codex 主密钥/ });
  if (await unknownKeyRow.isEnabled()) await unknownKeyRow.click();
  // The bridge handler records calls synchronously, so no timed polling is needed.
  check('Unknown configuration cannot be applied through the key selector or key dialog', await missingStatus.evaluate(previous => window.__betaFixture.calls.filter(call => call.action === 'apply').length === previous, unknownApplyCount));
  await missingStatus.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await assertStorage('Unknown native status leaves credential storage empty', missingStatus);

  const deniedSession = await scenarioPage('session-denied');
  await deniedSession.getByRole('heading', { name: /欢迎使用/ }).waitFor();
  await deniedSession.getByRole('alert').filter({ hasText: '当前账户没有内测权限' }).waitFor();
  check('Existing-session 403 shows beta denial rather than a generic connection failure', await deniedSession.getByRole('button', { name: '登录 Conpera', exact: true }).isEnabled() && !/账户服务暂不可用/.test(await deniedSession.locator('body').innerText()));
  check('Rejected existing session does not request account balance or keys', await deniedSession.evaluate(() => !window.__betaFixture.calls.some(call => ['balance', 'keys'].includes(call.action))));
  await assertStorage('Rejected existing session keeps all credential storage empty', deniedSession);

  await missingKeys.evaluate(() => { window.__betaFixture.sessionDenied = true; window.dispatchEvent(new Event('focus')); });
  await missingKeys.getByRole('alert').filter({ hasText: '当前账户没有内测权限' }).waitFor();
  check('A later session 403 clears account data while retaining native recovery controls', await missingKeys.getByRole('button', { name: '重新连接账户', exact: true }).isVisible() && await missingKeys.getByRole('button', { name: '刷新余额', exact: true }).count() === 0 && !/test77@|42\.75/.test(await missingKeys.locator('body').innerText()) && await missingKeys.getByTestId('tool-codex').getByRole('button', { name: '原机配置', exact: true }).isEnabled());
  check('Session denial clears the previous balance currency', await missingKeys.locator('.currency').innerText() === '' && await missingKeys.locator('.currency').getAttribute('aria-label') === null);
  await assertStorage('Later session denial does not retain credentials', missingKeys);

  const savedInternal = await scenarioPage('saved-internal');
  await savedInternal.waitForFunction(() => document.querySelector('[aria-label="Codex 渠道"]')?.textContent.includes('内部测试-实验渠道'));
  check('Restart preserves the applied internal channel without a configuration write', await savedInternal.getByRole('button', { name: 'Codex 高级选项', exact: true }).getAttribute('aria-expanded') === 'false' && (await savedInternal.getByRole('combobox', { name: 'Codex 密钥', exact: true }).innerText()).includes('ee04') && await savedInternal.evaluate(() => !window.__betaFixture.calls.some(call => call.action === 'apply')));
  const longLabels = await scenarioPage('long-labels');
  await longLabels.getByRole('combobox', { name: 'Codex 渠道', exact: true }).waitFor();
  await longLabels.getByRole('combobox', { name: 'Codex 渠道', exact: true }).click();
  const longMenu = longLabels.getByRole('listbox', { name: 'Codex 渠道', exact: true });
  check('Long channel labels wrap without a horizontal scrollbar', await longMenu.evaluate(el => el.scrollWidth <= el.clientWidth) && await longLabels.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await longLabels.screenshot({ path: join(output, 'channel-picker-long-channel.png') });
  await longLabels.keyboard.press('Escape');
  await longLabels.getByRole('combobox', { name: 'Codex 密钥', exact: true }).click();
  const longKeys = longLabels.getByRole('listbox', { name: 'Codex 密钥', exact: true });
  check('Long key names remain readable without horizontal scrolling', await longKeys.evaluate(el => el.scrollWidth <= el.clientWidth));
  await longLabels.screenshot({ path: join(output, 'channel-picker-long-key.png') });
  await savedInternal.close(); await longLabels.close();

  check('All application API calls use the native bridge without demo HTTP requests', !httpRequests.some(path => path.startsWith('/api/')));
  const bridgeCalls = await Promise.all([page, missingKeys, missingStatus, deniedSession].map(targetPage => targetPage.evaluate(() => window.__betaFixture.calls)));
  check('Native bridge request payloads contain no account token or API key', !/access.?token|refresh.?token|api.?key|code.?verifier/i.test(JSON.stringify(bridgeCalls)));
  check('No external requests or browser runtime exceptions occurred', blocked.length === 0 && errors.length === 0);
  await mkdir(output, { recursive: true });
  const report = { result: 'passed', scope: 'isolated Chromium + synthetic native Promise bridge; no production or real CLI configuration access', count: checks.length, checks, errors, blockedRequests: blocked, staticRequests: httpRequests.length };
  await writeFile(join(output, reportName), JSON.stringify(report, null, 2) + '\n');
  console.log(`\n${checks.length} isolated native browser checks passed.`);
  console.log(`Report: ${join(output, reportName)}`);
} finally {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
