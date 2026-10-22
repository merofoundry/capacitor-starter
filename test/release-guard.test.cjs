'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { checkRelease, generatedConfigPath } = require('../lib/release-guard.cjs');
const { cap, node, starterCopy } = require('./helpers/starter-fixture.cjs');

const STARTER = { host: 'shop.example.com', appId: 'com.example.shop', appName: 'Shop' };
const PREVIEW = { MEROSHELL_PREVIEW_HOST: 'preview-shop.example.com' };

test('the workflow stage rejects a preview override before anything is synced', () => {
  const dir = starterCopy({ starter: STARTER });
  for (const platform of ['ios', 'android']) {
    const errors = checkRelease({ rootDir: dir, env: PREVIEW, platform, stage: 'workflow' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /MEROSHELL_PREVIEW_HOST/);
    assert.deepEqual(checkRelease({ rootDir: dir, env: {}, platform, stage: 'workflow' }), []);
  }
});

test('the workflow stage rejects an invalid starter configuration', () => {
  const dir = starterCopy({ starter: { ...STARTER, host: 'https://shop.example.com' } });
  const errors = checkRelease({ rootDir: dir, env: {}, platform: 'android', stage: 'workflow' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /host/);
});

test('the release guard CLI exits non-zero with the reason, and zero when clean', () => {
  const dir = starterCopy({ starter: STARTER });
  const rejected = node(dir, ['scripts/release-guard.cjs', '--platform', 'ios', '--stage', 'workflow'], PREVIEW);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /preview builds are debug-only/);
  const clean = node(dir, ['scripts/release-guard.cjs', '--platform', 'ios', '--stage', 'workflow']);
  assert.equal(clean.status, 0, clean.stderr);
});

test('the release guard CLI rejects unknown platforms and stages', () => {
  const dir = starterCopy({ starter: STARTER });
  assert.equal(node(dir, ['scripts/release-guard.cjs', '--platform', 'web', '--stage', 'workflow']).status, 2);
  assert.equal(node(dir, ['scripts/release-guard.cjs', '--platform', 'ios', '--stage', 'ship']).status, 2);
});

test('the package stage requires a synced native configuration and assembled web assets', () => {
  const dir = starterCopy({ starter: STARTER });
  const errors = checkRelease({ rootDir: dir, env: {}, platform: 'ios', stage: 'package' });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /npx cap sync ios/);
  assert.match(errors[1], /www has no assembled web assets.*run npm run web, then npx cap sync ios/);
});

test('Android: preview sync then release is rejected at packaging; a clean resync passes', () => {
  const dir = starterCopy({ starter: STARTER, withAndroid: true });
  cap(dir, ['sync', 'android'], PREVIEW);
  const generated = JSON.parse(fs.readFileSync(generatedConfigPath(dir, 'android'), 'utf8'));
  assert.equal(generated.server.url, 'https://preview-shop.example.com', 'fixture really synced the preview host');

  const stale = checkRelease({ rootDir: dir, env: {}, platform: 'android', stage: 'package' });
  assert.equal(stale.length, 1);
  assert.match(stale[0], /preview-shop\.example\.com/);
  assert.match(stale[0], /npx cap sync android/);

  cap(dir, ['sync', 'android']);
  assert.deepEqual(checkRelease({ rootDir: dir, env: {}, platform: 'android', stage: 'package' }), []);
  const overridden = checkRelease({ rootDir: dir, env: PREVIEW, platform: 'android', stage: 'package' });
  assert.equal(overridden.length, 1, 'an override in the packaging environment is rejected on its own');
});

test('iOS: preview sync then release is rejected at packaging; a clean resync passes', () => {
  const dir = starterCopy({ starter: STARTER });
  cap(dir, ['add', 'ios']);
  cap(dir, ['sync', 'ios'], PREVIEW);
  const generated = JSON.parse(fs.readFileSync(generatedConfigPath(dir, 'ios'), 'utf8'));
  assert.equal(generated.server.url, 'https://preview-shop.example.com');

  const stale = checkRelease({ rootDir: dir, env: {}, platform: 'ios', stage: 'package' });
  assert.equal(stale.length, 1);
  assert.match(stale[0], /npx cap sync ios/);

  cap(dir, ['sync', 'ios']);
  assert.deepEqual(checkRelease({ rootDir: dir, env: {}, platform: 'ios', stage: 'package' }), []);
});

test('a generated configuration that drifted from starter.config.json is stale', () => {
  const dir = starterCopy({ starter: STARTER, withAndroid: true });
  cap(dir, ['sync', 'android']);
  fs.writeFileSync(path.join(dir, 'starter.config.json'), JSON.stringify({ ...STARTER, appId: 'com.example.other' }));
  const errors = checkRelease({ rootDir: dir, env: {}, platform: 'android', stage: 'package' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /appId/);
});

test('a hand-edited generated configuration that re-enables cleartext or mixed content is stale', () => {
  const dir = starterCopy({ starter: STARTER, withAndroid: true });
  cap(dir, ['sync', 'android']);
  const file = generatedConfigPath(dir, 'android');
  const generated = JSON.parse(fs.readFileSync(file, 'utf8'));
  generated.server.cleartext = true;
  generated.android.allowMixedContent = true;
  fs.writeFileSync(file, JSON.stringify(generated));
  const errors = checkRelease({ rootDir: dir, env: {}, platform: 'android', stage: 'package' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /server\.cleartext/);
  assert.match(errors[0], /android\.allowMixedContent/);
});

// Web-asset lifecycle: npm run web, cap sync and the package-stage guard, in both modes. The
// edits keep file timestamps, so only content can reveal them.

const { prepareWeb } = require('./helpers/starter-fixture.cjs');

const BUNDLED = { ...STARTER, mode: 'bundled', site: 'site' };
const SITE = { 'index.html': '<!doctype html><title>Shop</title>', 'assets/js/app.js': 'app()' };
const ANDROID_PUBLIC = path.join('android', 'app', 'src', 'main', 'assets', 'public');

function editKeepingTime(file, text) {
  const { atime, mtime } = fs.statSync(file);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, atime, mtime);
}

const packageErrors = (dir, platform) => checkRelease({ rootDir: dir, env: {}, platform, stage: 'package' });

test('Android bundled: assemble, sync and release; a nested site edit blocks release until rebuilt and resynced', () => {
  const dir = starterCopy({ starter: BUNDLED, withAndroid: true, siteFiles: SITE });
  prepareWeb(dir);
  cap(dir, ['sync', 'android']);
  const generated = JSON.parse(fs.readFileSync(generatedConfigPath(dir, 'android'), 'utf8'));
  assert.equal(generated.webDir, 'www');
  assert.equal(generated.server.url, undefined, 'bundled mode loads no remote server.url');
  assert.deepEqual(generated.server.allowNavigation, ['shop.example.com']);
  assert.deepEqual(generated.plugins.MeroShell, { starterVersion: '1.0.0', appId: 'com.example.shop', host: 'shop.example.com', mode: 'bundled' });
  assert.equal(fs.readFileSync(path.join(dir, ANDROID_PUBLIC, 'assets', 'js', 'app.js'), 'utf8'), 'app()');
  assert.ok(fs.existsSync(path.join(dir, ANDROID_PUBLIC, 'meroshell', 'index.html')));
  assert.deepEqual(packageErrors(dir, 'android'), []);

  editKeepingTime(path.join(dir, 'site', 'assets', 'js', 'app.js'), 'app2()');
  const stale = packageErrors(dir, 'android');
  assert.equal(stale.length, 1);
  assert.match(stale[0], /^www .*assets\/js\/app\.js changed; run npm run web, then npx cap sync android$/);

  prepareWeb(dir);
  const unsynced = packageErrors(dir, 'android');
  assert.equal(unsynced.length, 1);
  assert.match(unsynced[0], /android\/app\/src\/main\/assets\/public .*assets\/js\/app\.js changed; run npx cap sync android$/);

  cap(dir, ['sync', 'android']);
  assert.deepEqual(packageErrors(dir, 'android'), []);
});

test('the copy hook reassembles www on every sync, so additions and deletions reach the platform copy', () => {
  const dir = starterCopy({ starter: BUNDLED, withAndroid: true, siteFiles: SITE });
  prepareWeb(dir);
  cap(dir, ['sync', 'android']);
  fs.writeFileSync(path.join(dir, 'site', 'assets', 'js', 'added.js'), 'added()');
  fs.rmSync(path.join(dir, 'site', 'assets', 'js', 'app.js'));
  assert.match(packageErrors(dir, 'android').join('\n'), /added\.js added.*app\.js removed|app\.js removed.*added\.js added/);
  cap(dir, ['sync', 'android']);
  assert.deepEqual(packageErrors(dir, 'android'), []);
  assert.ok(fs.existsSync(path.join(dir, ANDROID_PUBLIC, 'assets', 'js', 'added.js')));
  assert.equal(fs.existsSync(path.join(dir, ANDROID_PUBLIC, 'assets', 'js', 'app.js')), false);
});

test('Android: switching modes without resyncing is a configuration and asset change the guard rejects', () => {
  const dir = starterCopy({ starter: STARTER, withAndroid: true, siteFiles: SITE });
  prepareWeb(dir);
  cap(dir, ['sync', 'android']);
  assert.deepEqual(packageErrors(dir, 'android'), []);
  fs.writeFileSync(path.join(dir, 'starter.config.json'), JSON.stringify(BUNDLED));
  const errors = packageErrors(dir, 'android').join('\n');
  assert.match(errors, /server\.url/);
  assert.match(errors, /plugins\.MeroShell/);
  assert.match(errors, /mode is "remote", expected "bundled"/);
  prepareWeb(dir);
  cap(dir, ['sync', 'android']);
  assert.deepEqual(packageErrors(dir, 'android'), []);
});

test('iOS remote and bundled: web assets first, then add, sync and release; a nested shell edit blocks release', () => {
  for (const starter of [STARTER, BUNDLED]) {
    const dir = starterCopy({ starter, siteFiles: starter.mode === 'bundled' ? SITE : undefined });
    prepareWeb(dir);
    cap(dir, ['add', 'ios']);
    cap(dir, ['sync', 'ios']);
    const generated = JSON.parse(fs.readFileSync(generatedConfigPath(dir, 'ios'), 'utf8'));
    assert.equal(generated.plugins.MeroShell.mode, starter.mode || 'remote');
    assert.equal(generated.plugins.MeroShell.host, 'shop.example.com');
    assert.equal(generated.server.url, starter.mode === 'bundled' ? undefined : 'https://shop.example.com');
    assert.deepEqual(packageErrors(dir, 'ios'), [], starter.mode || 'remote');

    editKeepingTime(path.join(dir, 'shell', 'controller.js'), '/* edited */');
    const stale = packageErrors(dir, 'ios');
    assert.equal(stale.length, 1);
    assert.match(stale[0], /meroshell\/controller\.js changed; run npm run web, then npx cap sync ios/);
    cap(dir, ['sync', 'ios']);
    assert.deepEqual(packageErrors(dir, 'ios'), []);
  }
});

test('a hand-edited platform copy no longer matches its manifest and is rejected', () => {
  const dir = starterCopy({ starter: STARTER, withAndroid: true });
  prepareWeb(dir);
  cap(dir, ['sync', 'android']);
  editKeepingTime(path.join(dir, ANDROID_PUBLIC, 'meroshell', 'hosted-integration.js'), '/* patched */');
  const errors = packageErrors(dir, 'android');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no longer matches its manifest: meroshell\/hosted-integration\.js changed; run npx cap sync android/);
});

test('the guard rejects a generated configuration with Capacitor logging re-enabled', () => {
  const dir = starterCopy({ starter: STARTER, withAndroid: true });
  cap(dir, ['sync', 'android']);
  const file = generatedConfigPath(dir, 'android');
  const generated = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(generated.loggingBehavior, 'none');
  generated.loggingBehavior = 'debug';
  fs.writeFileSync(file, JSON.stringify(generated));
  assert.match(packageErrors(dir, 'android').join('\n'), /loggingBehavior/);
});
