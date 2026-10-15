import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const project = fileURLToPath(new URL('..', import.meta.url));
export const sparkleVersion = '2.10.0';
const digest = 'c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c';
export const updatePublicKey = 'B41CJeq8hxzu3HbAOm2XY7y/fQwxmlNL1vIkuX4BY9g=';
export const updateFeed = 'https://github.com/conpera/conpera-switch/releases/latest/download/appcast.xml';

// Only the pinned official distribution is used; no executables are fetched at
// application runtime. Its license and helper signatures stay in the bundle.
export async function prepareSparkle() {
  const vendor = path.join(project, 'output/vendor');
  const archive = path.join(vendor, `Sparkle-${sparkleVersion}.tar.xz`);
  const root = path.join(vendor, `Sparkle-${sparkleVersion}`);
  await mkdir(vendor, { recursive: true });
  let bytes;
  try { bytes = await readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes) {
    const partial = archive + `.download-${process.pid}`;
    try {
      execFileSync('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2', '--connect-timeout', '15', '--max-time', '180',
        `https://github.com/sparkle-project/Sparkle/releases/download/${sparkleVersion}/Sparkle-${sparkleVersion}.tar.xz`, '--output', partial], { stdio: 'inherit' });
      bytes = await readFile(partial);
      if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Sparkle distribution checksum mismatch.');
      await rename(partial, archive);
    } finally { await rm(partial, { force: true }); }
  }
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Cached Sparkle distribution checksum mismatch.');
  try { await access(path.join(root, 'Sparkle.framework/Sparkle')); }
  catch {
    await mkdir(root, { recursive: true });
    execFileSync('/usr/bin/tar', ['-xJf', archive, '-C', root], { stdio: 'inherit' });
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(root, 'Sparkle.framework')], { stdio: 'inherit' });
  return root;
}
