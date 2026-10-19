import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
const mount = path.join(scratch, 'mounted');
let mounted = false;
try {
  const volume = path.join(scratch, 'volume');
  run('/usr/bin/ditto', [app, path.join(volume, 'Conpera Switch.app')]);
  await symlink('/Applications', path.join(volume, 'Applications'));
  await mkdir(path.join(volume, '.background'));
  const backgroundGenerator = path.join(scratch, 'generate-installer-background');
  run('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5', '-framework', 'AppKit',
    '-o', backgroundGenerator, path.join(project, 'native/generate-installer-background.swift')]);
  run(backgroundGenerator, [path.join(volume, '.background/background.tiff')]);
  const stem = `Conpera-Switch-${version}-mac-${architecture}`;
  const dmg = path.join(scratch, `${stem}.dmg`);
  const zip = path.join(scratch, `${stem}.zip`);
  const writable = path.join(scratch, 'installer.dmg');
  run('/usr/bin/hdiutil', ['create', '-volname', 'Conpera Switch Installer', '-srcfolder', volume, '-format', 'UDRW', '-fs', 'HFS+', writable]);
  await mkdir(mount);
  run('/usr/bin/hdiutil', ['attach', writable, '-mountpoint', mount, '-nobrowse', '-noautoopen']);
  mounted = true;
  // Finder writes the background alias and icon/window positions into .DS_Store
  // on the mounted image; the alias then survives renaming or moving the DMG.
  run('/usr/bin/osascript', [path.join(project, 'scripts/layout-installer.applescript'), mount], { timeout: 45_000 });
  if ((await stat(path.join(mount, '.DS_Store'))).size === 0) throw new Error('Finder did not save the installer layout.');
  run('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 });
  mounted = false;
  run('/usr/bin/hdiutil', ['convert', writable, '-format', 'UDZO', '-o', dmg]);
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
  // Never recursively remove a mount point if detaching the image fails.
  if (mounted) run('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 });
  await rm(scratch, { recursive: true, force: true });
}
