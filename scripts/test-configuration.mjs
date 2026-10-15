import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// No user CLI settings, account credentials, or network requests are used.
const project = fileURLToPath(new URL('..', import.meta.url));
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'conpera-configuration-test-')));
async function run(command, args) {
  const child = spawn(command, args, { cwd: project, stdio: 'inherit' });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 0, `Configuration harness failed (${signal ?? code})`);
}
try {
  const binary = join(scratch, 'configuration-tests');
  await run('swiftc', ['-swift-version', '6', join(project, 'native/ConfigurationManager.swift'), join(project, 'native/ConfigurationDocument.swift'),
    join(project, 'native/tests/configuration/main.swift'), '-o', binary]);
  await run(binary, [scratch]);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
