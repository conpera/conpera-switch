import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real Swift file operations behind the web UI, entirely inside a disposable
// HOME. The native fixture has no credentials and rejects all network access.
const project = fileURLToPath(new URL('..', import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), 'conpera-settings-browser-')));
const output = join(project, 'output', 'configuration-editor');
const { version } = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
const codexPath = join(root, '.codex/config.toml');
const claudePath = join(root, '.claude/settings.json');
const codexOriginal = '# isolated fixture\nmodel = "fixture-model"\nmodel_reasoning_effort = "high"\n[model_providers.fixture]\nbase_url = "https://fixture.invalid/v1"\nexperimental_bearer_token = "synthetic-settings-secret"\n';
const claudeOriginal = '{"model":"fixture-claude","env":{"ANTHROPIC_AUTH_TOKEN":"synthetic-claude-secret","UNRELATED":"keep"},"permissions":{"allow":["Read"]}}';
let bridge, server, browser;
const pending = [];
const failures = [];
const checks = [];
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log(`PASS: ${label}`); };
const call = request => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Native fixture timed out')), 10_000);
  pending.push({ resolve: value => { clearTimeout(timer); resolve(value); }, reject });
  bridge.stdin.write(JSON.stringify(request) + '\n');
});

try {
  await mkdir(output, { recursive: true });
  await mkdir(join(root, '.codex')); await mkdir(join(root, '.claude'));
  await writeFile(codexPath, codexOriginal, { mode: 0o600 });
  await writeFile(claudePath, claudeOriginal, { mode: 0o600 });
  const executable = join(root, 'settings-bridge');
  execFileSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-framework', 'AppKit', '-framework', 'Network', '-framework', 'CryptoKit', '-framework', 'Security',
    ...['AccountClient.swift', 'CredentialStore.swift', 'AuthorizationCallback.swift', 'ConfigurationManager.swift', 'ConfigurationDocument.swift', 'SwitchRuntime.swift', 'tests/settings-bridge/main.swift'].map(name => join(project, 'native', name)), '-o', executable], { stdio: 'inherit', timeout: 60_000 });
  bridge = spawn(executable, [root], { stdio: ['pipe', 'pipe', 'inherit'] });
  createInterface({ input: bridge.stdout }).on('line', line => pending.shift()?.resolve(JSON.parse(line)));
  bridge.on('exit', code => { if (pending.length) failures.push(`Native bridge exited ${code}`); });
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/fixture/bridge' && req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const reply = await call(JSON.parse(Buffer.concat(chunks).toString()));
        const text = JSON.stringify(reply);
        assert.ok(!text.includes('synthetic-settings-secret') && !text.includes('synthetic-claude-secret'), 'Native bridge leaked a credential');
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(text); return;
      }
      const file = resolve(project, 'dist', `.${req.url === '/' ? '/index.html' : new URL(req.url, 'http://fixture.invalid').pathname}`);
      assert.ok(file.startsWith(join(project, 'dist') + sep));
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(bytes);
    } catch (error) { failures.push(error.message); res.writeHead(500).end('Fixture failed'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 880, height: 740 }, reducedMotion: 'reduce', userAgent: `ConperaSwitchMac/${version} ConperaSwitchNative/${version}` });
  context.setDefaultTimeout(8000);
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    failures.push('External request attempted'); await route.abort();
  });
  await context.addInitScript(() => {
    window.webkit = { messageHandlers: { windowLayout: { postMessage() {} }, switch: { postMessage: async request => (await fetch('/fixture/bridge', { method: 'POST', body: JSON.stringify(request) })).json() } } };
  });
  const page = await context.newPage(); page.on('pageerror', error => failures.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: 'Codex 配置细节', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Codex 配置细节', exact: true });
  await dialog.getByLabel('模型', { exact: true }).waitFor();
  check('Settings can be read before account login', await dialog.getByLabel('模型', { exact: true }).inputValue() === 'fixture-model');
  await dialog.getByLabel('模型', { exact: true }).fill('custom-model');
  await dialog.getByLabel('思考强度', { exact: true }).selectOption('xhigh');
  await dialog.getByLabel('上下文窗口 · tokens', { exact: true }).fill('200000');
  await dialog.getByLabel('自动压缩阈值 · tokens', { exact: true }).fill('150000');
  await page.screenshot({ path: join(output, 'codex-form.png') });
  await dialog.getByRole('button', { name: '配置原文 TOML', exact: true }).click();
  const raw = dialog.getByLabel('Codex 配置原文', { exact: true });
  await raw.waitFor();
  const draft = await raw.inputValue();
  check('Form edits synchronize into TOML while credentials remain hidden', draft.includes('model = "custom-model"') && draft.includes('model_reasoning_effort = "xhigh"') && draft.includes('__CONPERA_PRIVATE_') && !draft.includes('synthetic-settings-secret'));
  await raw.fill('model = "unterminated');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'TOML' }).waitFor();
  check('Malformed raw TOML does not alter the file', await readFile(codexPath, 'utf8') === codexOriginal);
  await raw.fill(draft.replace('"custom-model"', '"raw-custom-model"'));
  await dialog.getByRole('button', { name: '常用设置', exact: true }).click();
  await dialog.getByLabel('模型', { exact: true }).waitFor();
  check('Raw edits synchronize back into the form', await dialog.getByLabel('模型', { exact: true }).inputValue() === 'raw-custom-model');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: '已保存并核验' }).waitFor();
  const saved = await readFile(codexPath, 'utf8');
  check('Saving from the UI writes through Swift and retains credential bytes', saved.includes('raw-custom-model') && saved.includes('synthetic-settings-secret') && !saved.includes('__CONPERA_PRIVATE_'));
  await dialog.getByRole('button', { name: '配置原文 TOML', exact: true }).click(); await raw.waitFor();
  await page.screenshot({ path: join(output, 'codex-raw.png') });
  await dialog.getByRole('button', { name: '撤销上次保存', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: '已撤销' }).waitFor();
  check('Undo from the UI restores the exact original file', await readFile(codexPath, 'utf8') === codexOriginal);
  const currentRaw = await raw.inputValue();
  await raw.fill(currentRaw.replace('fixture-model', 'unsaved-model'));
  await dialog.getByRole('button', { name: '关闭配置', exact: true }).click();
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
  check('Closing with unsaved edits keeps the draft when cancelled', (await raw.inputValue()).includes('unsaved-model'));
  await writeFile(codexPath, '# modified externally\n');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '配置已被其他操作修改' }).waitFor();
  check('Concurrent external writes are preserved and the editor keeps the draft', await readFile(codexPath, 'utf8') === '# modified externally\n' && (await raw.inputValue()).includes('unsaved-model'));
  await dialog.getByRole('button', { name: '关闭配置', exact: true }).click();
  await dialog.getByRole('button', { name: '放弃修改并继续', exact: true }).click();
  await page.getByRole('button', { name: 'Claude Code 配置细节', exact: true }).click();
  const claude = page.getByRole('dialog', { name: 'Claude Code 配置细节', exact: true });
  await claude.getByLabel('模型', { exact: true }).fill('custom-claude');
  await claude.getByLabel('扩展思考', { exact: true }).selectOption('false');
  await claude.getByLabel('最大输出长度 · tokens', { exact: true }).fill('32000');
  await claude.getByRole('button', { name: '配置原文 JSON', exact: true }).click();
  const jsonRaw = claude.getByLabel('Claude Code 配置原文', { exact: true }); await jsonRaw.waitFor();
  check('Claude form produces valid JSON and hides its auth token', JSON.parse(await jsonRaw.inputValue()).alwaysThinkingEnabled === false && !(await jsonRaw.inputValue()).includes('synthetic-claude-secret'));
  await claude.getByRole('button', { name: '保存配置', exact: true }).click();
  await claude.getByRole('status').filter({ hasText: '已保存并核验' }).waitFor();
  const claudeSaved = JSON.parse(await readFile(claudePath, 'utf8'));
  check('Claude settings persist without changing credentials or permission rules', claudeSaved.model === 'custom-claude' && claudeSaved.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS === '32000' && claudeSaved.env.ANTHROPIC_AUTH_TOKEN === 'synthetic-claude-secret' && claudeSaved.permissions.allow[0] === 'Read');
  await page.screenshot({ path: join(output, 'claude-raw.png') });
  await claude.getByRole('button', { name: '常用设置', exact: true }).click();
  await claude.getByLabel('模型', { exact: true }).waitFor();
  await page.setViewportSize({ width: 400, height: 600 });
  await page.screenshot({ path: join(output, 'claude-narrow.png') });
  check('Narrow settings dialog fits without horizontal overflow', await claude.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth));
  await claude.getByRole('button', { name: '撤销上次保存', exact: true }).click();
  await claude.getByRole('status').filter({ hasText: '已撤销' }).waitFor();
  check('Claude undo restores original JSON bytes', await readFile(claudePath, 'utf8') === claudeOriginal);
  check('Settings editing writes no browser storage', await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0));
  check('No external requests, native bridge leaks or browser exceptions', failures.length === 0);
  await writeFile(join(output, 'report.json'), JSON.stringify({ count: checks.length, checks, failures, scope: 'Real Swift settings runtime; isolated temporary HOME; no Keychain, account or model access' }, null, 2) + '\n');
  console.log(`${checks.length} native settings browser checks passed.`);
} finally {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  bridge?.stdin.end();
  if (bridge && bridge.exitCode === null) { bridge.kill(); await once(bridge, 'exit'); }
  await rm(root, { recursive: true, force: true });
}
