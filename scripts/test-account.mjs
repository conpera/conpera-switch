import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'conpera-account-test-')));
async function run(command, args, timeout) {
  const child = spawn(command, args, { cwd: project, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, 0, `${command} failed (${signal ?? code})`);
  } finally { clearTimeout(timer); }
}
try {
  const executable = join(scratch, 'account-tests');
  await run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5',
    '-framework', 'AppKit', '-framework', 'Network', '-framework', 'CryptoKit', '-framework', 'Security',
    join(project, 'native/AccountClient.swift'), join(project, 'native/CredentialStore.swift'),
    join(project, 'native/AuthorizationCallback.swift'), join(project, 'native/ConfigurationManager.swift'), join(project, 'native/ConfigurationDocument.swift'),
    join(project, 'native/SwitchRuntime.swift'), join(project, 'native/tests/account/main.swift'),
    '-o', executable], 60_000);
  await run(executable, [scratch], 45_000);
} finally { await rm(scratch, { recursive: true, force: true }); }
