import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareSparkle, project, updatePublicKey } from './sparkle.mjs';

const { version } = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
const release = path.join(project, 'release', version);
const manifestPath = path.join(release, 'release-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.version !== version) throw new Error('Build the matching installers first.');
const archive = manifest.assets.find(asset => asset.name.endsWith('.zip'));
if (!archive) throw new Error('Missing ZIP update archive.');
const archivePath = path.join(release, archive.name);
if (createHash('sha256').update(await readFile(archivePath)).digest('hex') !== archive.sha256) throw new Error('Update archive changed after packaging.');
const keyPath = process.env.CONPERA_UPDATE_KEY_FILE || path.join(os.homedir(), 'Library/Application Support/Conpera Switch Release/ed25519.key');
const handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
try {
  const info = await handle.stat();
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 256) throw new Error('Release signing key must be a private regular file (0600).');
  const seed = Buffer.from((await handle.readFile('utf8')).trim(), 'base64');
  if (seed.length !== 32) throw new Error('Expected a 32-byte Ed25519 seed.');
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  if (publicKey !== updatePublicKey) throw new Error('Release signing key does not match the public key embedded in the app.');
} finally { await handle.close(); }
const sparkle = await prepareSparkle();
const scratch = await mkdtemp(path.join(os.tmpdir(), 'conpera-appcast-'));
try {
  await cp(archivePath, path.join(scratch, archive.name));
  execFileSync(path.join(sparkle, 'bin/generate_appcast'), ['--ed-key-file', keyPath, '--maximum-deltas', '0',
    '--download-url-prefix', `https://github.com/conpera/conpera-switch/releases/download/v${version}/`,
    '--link', 'https://github.com/conpera/conpera-switch/releases', scratch], { stdio: 'inherit', timeout: 120_000 });
  const feed = path.join(scratch, 'appcast.xml');
  execFileSync(path.join(sparkle, 'bin/sign_update'), ['--verify', '--ed-key-file', keyPath, feed], { stdio: 'inherit' });
  const bytes = await readFile(feed);
  await cp(feed, path.join(release, 'appcast.xml'));
  manifest.assets = manifest.assets.filter(asset => asset.name !== 'appcast.xml');
  manifest.assets.push({ name: 'appcast.xml', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  manifest.updates = { framework: 'Sparkle 2.10.0', feed: 'https://github.com/conpera/conpera-switch/releases/latest/download/appcast.xml', signedFeed: true, verifyBeforeExtraction: true };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(release, 'SHA256SUMS'), manifest.assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''));
  console.log('Signed appcast ready; publish it alongside the installers in the GitHub release.');
} finally { await rm(scratch, { recursive: true, force: true }); }
