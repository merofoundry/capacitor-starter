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
  assert.equal(config.webDir, 'www');
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

// Delivery mode (remote or bundled) and the bundled site.

/** A starter root holding a built site at `site` (relative), with `files` inside it. */
function bundledDir(starter, files = { 'index.html': '<!doctype html><title>Shop</title>' }, site = 'site') {
  const dir = fixtureDir(starter);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, site, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, site, name), text);
  }
  return dir;
}

test('an omitted mode is remote, and remote may also be explicit', () => {
  assert.equal(readStarterConfig(fixtureDir(STARTER)).mode, 'remote');
  const explicit = readStarterConfig(fixtureDir({ ...STARTER, mode: 'remote' }));
  assert.equal(explicit.mode, 'remote');
  assert.equal('site' in explicit, false);
});

test('bundled mode reads a site directory relative to the starter root', () => {
  const dir = bundledDir({ ...STARTER, mode: 'bundled', site: 'site' });
  assert.deepEqual(readStarterConfig(dir), { ...STARTER, mode: 'bundled', site: 'site' });
  const outside = bundledDir({ ...STARTER, mode: 'bundled', site: '../customer-site/dist' }, undefined, '../customer-site/dist');
  assert.equal(readStarterConfig(outside).site, '../customer-site/dist');
});

test('an unknown mode is a configuration error', () => {
  for (const mode of ['local', 'Bundled', '', null, 1]) {
    assert.throws(() => readStarterConfig(fixtureDir({ ...STARTER, mode })), (error) => error instanceof ShellConfigError && /mode/.test(error.message));
    assert.throws(() => buildCapacitorConfig({ starter: { ...STARTER, mode }, starterVersion: '1.0.0' }), ShellConfigError);
  }
});

test('bundled mode requires a site and remote mode refuses one', () => {
  assert.throws(() => readStarterConfig(fixtureDir({ ...STARTER, mode: 'bundled' })), /site/);
  assert.throws(() => readStarterConfig(bundledDir({ ...STARTER, site: 'site' })), /site.*bundled/);
  assert.throws(() => readStarterConfig(bundledDir({ ...STARTER, mode: 'remote', site: 'site' })), ShellConfigError);
});

test('a missing, unreadable or index-less bundled site is a configuration error', () => {
  const missing = fixtureDir({ ...STARTER, mode: 'bundled', site: 'site' });
  assert.throws(() => readStarterConfig(missing), (error) => error instanceof ShellConfigError && /site "site"/.test(error.message));
  const noIndex = bundledDir({ ...STARTER, mode: 'bundled', site: 'site' }, { 'app.js': '' });
  assert.throws(() => readStarterConfig(noIndex), /index\.html/);
  const file = fixtureDir({ ...STARTER, mode: 'bundled', site: 'site' });
  fs.writeFileSync(path.join(file, 'site'), 'not a directory');
  assert.throws(() => readStarterConfig(file), /not a directory/);
  if (process.getuid && process.getuid() !== 0) {
    const unreadable = bundledDir({ ...STARTER, mode: 'bundled', site: 'site' });
    fs.chmodSync(path.join(unreadable, 'site', 'index.html'), 0o000);
    assert.throws(() => readStarterConfig(unreadable), (error) => error instanceof ShellConfigError && /index\.html/.test(error.message));
    fs.chmodSync(path.join(unreadable, 'site', 'index.html'), 0o644);
  }
});

test('the bundled site path must be relative and must not hold or sit inside the assembled www directory', () => {
  for (const site of ['', '/srv/site', 7]) {
    const dir = bundledDir({ ...STARTER, mode: 'bundled', site });
    assert.throws(() => readStarterConfig(dir), /site must be a relative path/, String(site));
  }
  for (const site of ['.', 'www', 'www/site']) {
    const dir = bundledDir({ ...STARTER, mode: 'bundled', site }, { 'index.html': 'x' }, site);
    assert.throws(() => readStarterConfig(dir), /www/, site);
  }
  const parent = tempDir('meroshell-parent-');
  fs.writeFileSync(path.join(parent, 'index.html'), 'x');
  const nested = path.join(parent, 'starter');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'starter.config.json'), JSON.stringify({ ...STARTER, mode: 'bundled', site: '..' }));
  assert.throws(() => readStarterConfig(nested), /www/);
});

test('loadCapacitorConfig validates the bundled site on disk', () => {
  const dir = fixtureDir({ ...STARTER, mode: 'bundled', site: 'site' });
  assert.throws(() => loadCapacitorConfig({ rootDir: dir, env: {} }), ShellConfigError);
});

test('both modes use www; remote keeps server.url, bundled omits it and keeps the navigation lock', () => {
  const remote = buildCapacitorConfig({ starter: STARTER, starterVersion: '2.3.4' });
  assert.equal(remote.webDir, 'www');
  assert.equal(remote.server.url, 'https://shop.example.com');
  const bundled = buildCapacitorConfig({ starter: { ...STARTER, mode: 'bundled', site: 'site' }, starterVersion: '2.3.4' });
  assert.equal(bundled.webDir, 'www');
  assert.equal('url' in bundled.server, false);
  assert.deepEqual(bundled.server.allowNavigation, ['shop.example.com']);
  assert.equal(bundled.server.cleartext, false);
  assert.equal(bundled.android.allowMixedContent, false);
});

test('the bootstraps receive app id, host and mode in the plugin configuration, independent of server.url', () => {
  const remote = buildCapacitorConfig({ starter: STARTER, starterVersion: '2.3.4' });
  assert.deepEqual(remote.plugins.MeroShell, { starterVersion: '2.3.4', appId: 'com.example.shop', host: 'shop.example.com', mode: 'remote' });
  const bundled = loadCapacitorConfig({ rootDir: bundledDir({ ...STARTER, mode: 'bundled', site: 'site' }), env: {} });
  assert.deepEqual(bundled.plugins.MeroShell, { starterVersion: '2.3.4', appId: 'com.example.shop', host: 'shop.example.com', mode: 'bundled' });
  const preview = loadCapacitorConfig({
    rootDir: bundledDir({ ...STARTER, mode: 'bundled', site: 'site' }),
    env: { [PREVIEW_ENV]: 'preview-shop.example.com' },
  });
  assert.equal(preview.plugins.MeroShell.host, 'preview-shop.example.com');
  assert.deepEqual(preview.server.allowNavigation, ['preview-shop.example.com']);
  assert.equal('url' in preview.server, false);
});

test('Capacitor bridge logging is off in both modes, so plugin call data (session tokens) is never logged', () => {
  for (const starter of [STARTER, { ...STARTER, mode: 'bundled', site: 'site' }]) {
    assert.equal(buildCapacitorConfig({ starter, starterVersion: '1.0.0' }).loggingBehavior, 'none');
  }
});
