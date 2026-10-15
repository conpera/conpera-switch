import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareSparkle, project } from './sparkle.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'conpera-updater-fixture-'));
const fixtureID = `ai.conpera.switch.update-test.${path.basename(root).split('-').at(-1)}`;
const sparkle = await prepareSparkle();
const run = (cmd, args, options={}) => execFileSync(cmd, args, { stdio:'inherit', ...options });
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const key = path.join(root, 'test-signing.key');
await writeFile(key, privateKey.export({format:'der',type:'pkcs8'}).subarray(-32).toString('base64'), {mode:0o600});
const pub = publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
const feedRoot = path.join(root,'feed'); await mkdir(feedRoot);
await writeFile(path.join(root,'scenario.txt'), 'valid');
const server = createServer(async (req,res) => {
  try {
    const scenario = (await readFile(path.join(root,'scenario.txt'),'utf8')).trim();
    const pathname = new URL(req.url,'http://127.0.0.1').pathname;
    if (pathname === '/appcast.xml') {
      if (scenario === 'offline') { res.writeHead(503).end('offline fixture'); return; }
      let feed = await readFile(path.join(feedRoot,'appcast.xml'));
      if (scenario === 'tampered-feed') feed = Buffer.from(feed.toString().replace('<title>', '<title>modified '));
      res.writeHead(200, {'Content-Type':'application/xml','Cache-Control':'no-store'}).end(feed); return;
    }
    if (pathname === '/update.zip') {
      const bytes = await readFile(path.join(feedRoot,'update.zip'));
      if (scenario === 'tampered-archive') bytes[100] ^= 1;
      res.writeHead(200, {'Content-Type':'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store'}).end(bytes); return;
    }
    res.writeHead(404).end();
  } catch { res.writeHead(500).end(); }
});
server.listen(0,'127.0.0.1'); await once(server,'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const executable = path.join(root,'UpdateFixture');
run('/usr/bin/xcrun',['swiftc','-swift-version','5','-target','arm64-apple-macosx13.0','-framework','AppKit','-framework','Network','-framework','CryptoKit','-framework','Security','-F',sparkle,'-framework','Sparkle','-Xlinker','-rpath','-Xlinker','@executable_path/../Frameworks',...['AccountClient.swift','CredentialStore.swift','AuthorizationCallback.swift','ConfigurationManager.swift','ConfigurationDocument.swift','SwitchRuntime.swift','ApplicationUpdater.swift','tests/updater/main.swift'].map(f=>path.join(project,'native',f)),'-o',executable]);
const xmlEscape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
const apps = {};
for (const [slot, version] of [['installed','1.0.0'],['incoming','1.1.0']]) {
  const app = path.join(root,slot,'Conpera Update Test.app'); apps[slot]=app;
  const contents=path.join(app,'Contents');
  await mkdir(path.join(contents,'MacOS'),{recursive:true}); await mkdir(path.join(contents,'Resources')); await mkdir(path.join(contents,'Frameworks'));
  await cp(executable,path.join(contents,'MacOS/UpdateFixture'));
  run('/usr/bin/ditto',[path.join(sparkle,'Sparkle.framework'),path.join(contents,'Frameworks/Sparkle.framework')]);
  await writeFile(path.join(contents,'Resources/fixture-root.txt'),root);
  const strings={CFBundleIdentifier:fixtureID,CFBundleName:'Conpera Update Test',CFBundleDisplayName:'Conpera Update Test',CFBundleExecutable:'UpdateFixture',CFBundlePackageType:'APPL',CFBundleVersion:version,CFBundleShortVersionString:version,LSMinimumSystemVersion:'13.0',SUFeedURL:origin+'/appcast.xml',SUPublicEDKey:pub};
  const flags={SUEnableAutomaticChecks:false,SUAutomaticallyUpdate:false,SUAllowsAutomaticUpdates:false,SUEnableSystemProfiling:false,SURequireSignedFeed:true,SUVerifyUpdateBeforeExtraction:true};
  const plist='<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>'+Object.entries(strings).map(([k,v])=>`<key>${k}</key><string>${xmlEscape(v)}</string>`).join('')+Object.entries(flags).map(([k,v])=>`<key>${k}</key><${v}/>`).join('')+'<key>SUSignedFeedFailureExpirationInterval</key><integer>0</integer><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>';
  await writeFile(path.join(contents,'Info.plist'),plist);
  run('/usr/bin/codesign',['--force','--sign','-',app]);
  run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
}
run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',apps.incoming,path.join(feedRoot,'update.zip')]);
run(path.join(sparkle,'bin/generate_appcast'),['--ed-key-file',key,'--maximum-deltas','0','--download-url-prefix',origin+'/',feedRoot]);
const state={root,fixtureID,app:apps.installed,incoming:apps.incoming,origin,scenarioFile:path.join(root,'scenario.txt')};
await mkdir(path.join(project,'output/updater'),{recursive:true});
await writeFile(path.join(project,'output/updater/fixture.json'),JSON.stringify(state,null,2));
console.log(JSON.stringify(state));
console.log('Fixture server is ready; all update actions target the disposable application. Stop with Ctrl-C after quitting it.');

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  server.close();
  // Keep a running app's files intact; fixtures have a unique executable path.
  const { spawnSync } = await import('node:child_process');
  const running = spawnSync('/usr/bin/pgrep', ['-f', apps.installed + '/Contents/MacOS/UpdateFixture'], { stdio: 'ignore' }).status === 0;
  if (!running) await rm(root, { recursive: true, force: true });
  process.exit(0);
});
