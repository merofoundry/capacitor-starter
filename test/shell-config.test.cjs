'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers/temp.cjs');

const {
  PREVIEW_ENV,
  ShellConfigError,
  buildCapacitorConfig,
  loadCapacitorConfig,
  readStarterConfig,
  validateHost,
} = require('../lib/shell-config.cjs');

const STARTER = { host: 'shop.example.com', appId: 'com.example.shop', appName: 'Shop' };

function fixtureDir(starter, version = '2.3.4') {
  const dir = tempDir('meroshell-config-');
  fs.writeFileSync(path.join(dir, 'starter.config.json'), JSON.stringify(starter));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));
  return dir;
}

test('valid configuration produces the remote-loaded Capacitor config', () => {
  const config = buildCapacitorConfig({ starter: STARTER, starterVersion: '2.3.4' });
  assert.equal(config.appId, 'com.example.shop');
  assert.equal(config.appName, 'Shop');
  assert.equal(config.webDir, 'shell');
  assert.equal(config.server.url, 'https://shop.example.com');
  assert.deepEqual(config.server.allowNavigation, ['shop.example.com']);
  assert.equal(config.server.cleartext, false);
  assert.equal(config.android.allowMixedContent, false);
  assert.equal(config.appendUserAgent, 'MeroFoundryShell/2.3.4');
  assert.equal(config.plugins.MeroShell.starterVersion, '2.3.4');
});

test('loadCapacitorConfig reads host, app id, app name and the starter version from disk', () => {
  const dir = fixtureDir(STARTER, '9.8.7');
  const config = loadCapacitorConfig({ rootDir: dir, env: {} });
  assert.equal(config.server.url, 'https://shop.example.com');
  assert.equal(config.appId, 'com.example.shop');
  assert.equal(config.appName, 'Shop');
  assert.equal(config.appendUserAgent, 'MeroFoundryShell/9.8.7');
});

test('the committed starter.config.json and package.json load cleanly', () => {
  const root = path.join(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const config = loadCapacitorConfig({ rootDir: root, env: {} });
  assert.equal(config.appendUserAgent, `MeroFoundryShell/${version}`);
  assert.deepEqual(config.server.allowNavigation, [new URL(config.server.url).hostname]);
});

const INVALID_HOSTS = [
  ['', 'empty'],
  ['https://shop.example.com', 'scheme'],
  ['http://shop.example.com', 'cleartext scheme'],
  ['shop.example.com/', 'trailing slash'],
  ['shop.example.com/path', 'path'],
  ['shop.example.com:443', 'port'],
  ['Shop.Example.com', 'uppercase'],
  ['localhost', 'single label'],
  ['192.168.1.10', 'IPv4 address'],
  ['[::1]', 'IPv6 address'],
  ['shop..example.com', 'empty label'],
  ['-shop.example.com', 'leading hyphen'],
  ['shop-.example.com', 'trailing hyphen'],
  ['*.example.com', 'wildcard'],
  [' shop.example.com', 'whitespace'],
  ['shop.example.com.', 'trailing dot'],
  ['user@shop.example.com', 'userinfo'],
  ['shop.example.com?x=1', 'query'],
  ['bücher.example.com', 'non-ASCII'],
  [`${'a'.repeat(64)}.example.com`, 'label over 63 characters'],
  [`${'abcdefghi.'.repeat(26)}com`, 'name over 253 characters'],
  ['shop.example.123', 'numeric top-level label'],
];

for (const [host, why] of INVALID_HOSTS) {
  test(`host is rejected: ${why}`, () => {
    assert.throws(() => validateHost(host), ShellConfigError);
    assert.throws(
      () => buildCapacitorConfig({ starter: { ...STARTER, host }, starterVersion: '1.0.0' }),
      ShellConfigError,
    );
  });
}

test('non-string host is rejected', () => {
  for (const host of [undefined, null, 42, ['shop.example.com']]) {
    assert.throws(() => validateHost(host), ShellConfigError);
  }
});

test('valid host forms are accepted unchanged', () => {
  for (const host of ['example.com', 'a.b.example.co.uk', 'xn--bcher-kva.example.com', 'app-1.example.io']) {
    assert.equal(validateHost(host), host);
  }
});

test('app id and app name are validated', () => {
  for (const appId of ['', 'shop', 'com.example.', '1com.example.shop', 'com.example-shop.app', 'com..shop']) {
    assert.throws(() => buildCapacitorConfig({ starter: { ...STARTER, appId }, starterVersion: '1.0.0' }), ShellConfigError);
  }
  for (const appName of ['', '   ', 7]) {
    assert.throws(() => buildCapacitorConfig({ starter: { ...STARTER, appName }, starterVersion: '1.0.0' }), ShellConfigError);
  }
});

test('starter.config.json rejects unknown keys so a typo cannot silently fall back', () => {
  const dir = fixtureDir({ ...STARTER, hots: 'x.example.com' });
  assert.throws(() => readStarterConfig(dir), /unknown key "hots"/);
});

test('a missing or malformed starter.config.json is a configuration error', () => {
  const dir = tempDir('meroshell-config-');
  assert.throws(() => readStarterConfig(dir), ShellConfigError);
  fs.writeFileSync(path.join(dir, 'starter.config.json'), '{not json');
  assert.throws(() => readStarterConfig(dir), ShellConfigError);
});

test('the preview override replaces the host and nothing else', () => {
  const dir = fixtureDir(STARTER);
  const config = loadCapacitorConfig({ rootDir: dir, env: { [PREVIEW_ENV]: 'preview-shop.example.com' } });
  assert.equal(config.server.url, 'https://preview-shop.example.com');
  assert.deepEqual(config.server.allowNavigation, ['preview-shop.example.com']);
  assert.equal(config.server.cleartext, false);
  assert.equal(config.appId, 'com.example.shop');
});

test('the preview override is validated like the host', () => {
  const dir = fixtureDir(STARTER);
  assert.throws(
    () => loadCapacitorConfig({ rootDir: dir, env: { [PREVIEW_ENV]: 'http://preview.example.com' } }),
    ShellConfigError,
  );
});

test('an empty preview override is treated as absent', () => {
  const dir = fixtureDir(STARTER);
  const config = loadCapacitorConfig({ rootDir: dir, env: { [PREVIEW_ENV]: '' } });
  assert.equal(config.server.url, 'https://shop.example.com');
});
