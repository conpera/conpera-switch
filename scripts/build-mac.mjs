import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const beta = process.argv.includes('--beta');
const demo = process.argv.includes('--demo');
if (beta && demo) throw new Error('Choose only one edition.');
const native = !demo;
const version = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
const releaseRoot = path.join(projectRoot, 'release', native && !beta ? version : '');
const appName = beta ? 'Conpera Switch Beta.app' : 'Conpera Switch.app';
const destination = path.join(releaseRoot, appName);
const bundleIdentifier = beta ? 'ai.conpera.switch.beta' : demo ? 'ai.conpera.switch.demo' : 'ai.conpera.switch';
const architecture = { arm64: 'arm64', x64: 'x86_64' }[process.arch];

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
}

async function requireFile(relativePath) {
  try {
    await access(path.join(projectRoot, relativePath));
  } catch {
    throw new Error(`Missing ${relativePath}. Run npm run build first and ensure the native sources are present.`);
  }
}

if (process.platform !== 'darwin' || !architecture) {
  throw new Error('This build requires an Apple Silicon or Intel Mac with the Xcode Command Line Tools.');
}

await Promise.all([
  'dist/index.html',
  'native/main.swift',
  'native/LocalDemoServer.swift',
  'native/Info.plist',
  'native/generate-icon.swift',
  'public/favicon.svg',
].map(requireFile));

// All temporary files live in a directory created by this invocation. The only
// replaced destination is this project's own, identifier-verified app bundle.
const scratch = await mkdtemp(path.join(os.tmpdir(), 'conpera-switch-build-'));
try {
  const stagedApp = path.join(scratch, appName);
  const contents = path.join(stagedApp, 'Contents');
  const resources = path.join(contents, 'Resources');
  const executable = path.join(contents, 'MacOS', 'ConperaSwitch');
  const iconset = path.join(scratch, 'ConperaSwitch.iconset');

  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(resources, { recursive: true });
  await cp(path.join(projectRoot, 'native', 'Info.plist'), path.join(contents, 'Info.plist'));
  await cp(path.join(projectRoot, 'dist'), path.join(resources, 'web'), { recursive: true });

  for (const [key, value] of Object.entries({
    CFBundleIdentifier: bundleIdentifier,
    CFBundleDisplayName: beta ? 'Conpera Switch Beta' : 'Conpera Switch',
    CFBundleName: beta ? 'Conpera Switch Beta' : 'Conpera Switch',
    CFBundleShortVersionString: beta ? '0.2.0' : demo ? '0.1.0' : version,
    CFBundleVersion: beta ? '2' : demo ? '1' : version,
  })) {
    run('/usr/bin/plutil', ['-replace', key, '-string', value, path.join(contents, 'Info.plist')]);
  }
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await cp(path.join(projectRoot, name), path.join(resources, name));
  }

  run('/usr/bin/xcrun', [
    'swiftc', '-O', '-swift-version', '5',
    '-target', `${architecture}-apple-macosx13.0`,
    '-framework', 'AppKit', '-framework', 'WebKit',
    '-framework', 'Network', '-framework', 'CryptoKit', '-framework', 'Security',
    ...(native ? ['-D', 'SWITCH_NATIVE'] : []),
    ...(beta ? ['-D', 'SWITCH_BETA'] : []),
    '-o', executable,
    path.join(projectRoot, 'native', 'main.swift'),
    path.join(projectRoot, 'native', 'LocalDemoServer.swift'),
    ...(native ? ['AccountClient.swift', 'CredentialStore.swift', 'AuthorizationCallback.swift', 'ConfigurationManager.swift', 'SwitchRuntime.swift'].map(name => path.join(projectRoot, 'native', name)) : []),
  ]);

  const iconGenerator = path.join(scratch, 'generate-icon');
  run('/usr/bin/xcrun', [
    'swiftc', '-O', '-swift-version', '5', '-framework', 'AppKit',
    '-o', iconGenerator, path.join(projectRoot, 'native', 'generate-icon.swift'),
  ]);
  run(iconGenerator, [path.join(projectRoot, 'public', 'favicon.svg'), iconset]);
  run('/usr/bin/iconutil', ['--convert', 'icns', '--output', path.join(resources, 'ConperaSwitch.icns'), iconset]);
  await cp(path.join(iconset, 'icon_512x512@2x.png'), path.join(resources, 'ConperaSwitch.png'));

  run('/usr/bin/plutil', ['-lint', path.join(contents, 'Info.plist')]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', stagedApp]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp]);

  await mkdir(releaseRoot, { recursive: true });
  let existingBundle = false;
  try {
    await access(destination);
    existingBundle = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existingBundle) {
    const identifier = run('/usr/bin/plutil', [
      '-extract', 'CFBundleIdentifier', 'raw', '-o', '-',
      path.join(destination, 'Contents', 'Info.plist'),
    ], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim();
    if (identifier !== bundleIdentifier) {
      throw new Error(`Refusing to replace an unrelated bundle at ${destination}.`);
    }
    await rm(destination, { recursive: true });
  }
  // Copy first: temporary folders and the workspace may use different volumes.
  await cp(stagedApp, destination, { recursive: true, preserveTimestamps: true });
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination]);
  console.log(`\nBuilt ${destination}`);
  console.log(`Architecture: ${architecture}; minimum macOS: 13.0.`);
  console.log(native ? `Native ${beta ? 'beta' : version}: real account bridge and reversible local configuration.` : 'Self-contained demo: the installed app needs no Node.js or npm process.');
  console.log('Signed ad hoc for local use; not Developer ID signed or notarized.');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
