import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
if (process.platform !== 'darwin' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A macOS release build is required.');
const architecture = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
if (!architecture) throw new Error('Unsupported architecture.');
const root = path.join(project, 'release', version);
const app = path.join(root, 'Conpera Switch.app');
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const plistValue = key => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim();
if (plistValue('CFBundleIdentifier') !== 'ai.conpera.switch' || plistValue('CFBundleShortVersionString') !== version) throw new Error('Build the matching production app first.');
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const scratch = await mkdtemp(path.join(os.tmpdir(), 'conpera-switch-package-'));
try {
  const volume = path.join(scratch, 'volume');
  await cp(app, path.join(volume, 'Conpera Switch.app'), { recursive: true, preserveTimestamps: true });
  await symlink('/Applications', path.join(volume, 'Applications'));
  await writeFile(path.join(volume, '安装说明.txt'), `Conpera Switch ${version}\n\n将 Conpera Switch 拖入 Applications（应用程序）后打开。\n需要 macOS 13 或更高版本。此安装包适用于 ${architecture}。\n\n此版本采用 ad-hoc 签名，尚未完成 Apple Developer ID 签名与公证。\n若 macOS 阻止启动，可在「系统设置 → 隐私与安全性」中核对应用后选择「仍要打开」。\n\n登录您状态正常的 Conpera 账户，选择本人密钥后启用。\n配置切换后请重启 Codex / Claude Code。应用菜单提供恢复原机配置。\n\n源码与问题反馈：https://github.com/conpera/conpera-switch\n`);
  const stem = `Conpera-Switch-${version}-mac-${architecture}`;
  const dmg = path.join(scratch, `${stem}.dmg`);
  const zip = path.join(scratch, `${stem}.zip`);
  run('/usr/bin/hdiutil', ['create', '-volname', `Conpera Switch ${version}`, '-srcfolder', volume, '-format', 'UDZO', '-fs', 'HFS+', dmg]);
  run('/usr/bin/hdiutil', ['verify', dmg]);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  const assets = [];
  for (const source of [dmg, zip]) {
    const name = path.basename(source);
    const bytes = await readFile(source);
    assets.push({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    await cp(source, path.join(root, name));
  }
  await writeFile(path.join(root, 'SHA256SUMS'), assets.map(a => `${a.sha256}  ${a.name}\n`).join(''));
  await writeFile(path.join(root, 'release-manifest.json'), JSON.stringify({ version, architecture, minimumMacOS: '13.0', bundleIdentifier: 'ai.conpera.switch', signing: 'ad-hoc', notarized: false, assets }, null, 2) + '\n');
  console.log(`\nInstaller: ${path.join(root, `${stem}.dmg`)}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
