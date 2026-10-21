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

test('the package stage requires a synced native configuration', () => {
  const dir = starterCopy({ starter: STARTER });
  const errors = checkRelease({ rootDir: dir, env: {}, platform: 'ios', stage: 'package' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /npx cap sync ios/);
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
