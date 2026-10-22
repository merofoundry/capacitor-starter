'use strict';

/*
 * Runs the real overlay page: shell/index.html's scripts, in the order the page loads them,
 * inside a VM context whose only native surface is the platform transport double. This
 * exercises the actual bootstrap wiring (channel, controller, view, main) end to end. It does
 * not run on a device: whether the native plugin delivers these messages, covers the hosted
 * WebView and prompts biometrics as modelled is outside what this test can establish.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse } = require('parse5');

const { FakeDocument } = require('./helpers/fake-dom.cjs');

const SHELL = path.join(__dirname, '..', 'shell');
const LAUNCH = {
  platform: 'android',
  host: 'shop.example.com',
  appName: 'Shop',
  appVersion: '1.4.0 (12)',
  starterVersion: '1.0.0',
  lockEnabled: false,
  biometry: { available: true, kind: 'faceId' },
};

function scriptOrder(html) {
  const sources = [];
  (function walk(node) {
    if (node.tagName === 'script') {
      const src = node.attrs.find((a) => a.name === 'src');
      if (src) {
        sources.push(src.value);
      }
    }
    (node.childNodes || []).forEach(walk);
  })(parse(html));
  return sources;
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function boot(transport = 'android', shellDir = SHELL) {
  const html = fs.readFileSync(path.join(shellDir, 'index.html'), 'utf8');
  const document = new FakeDocument(html);
  const posted = [];
  const window = { document, URL, console: { warn() {} } };
  // Like the native side, acknowledge every command at once, except the ones whose answer a
  // test decides: launch state, the biometric prompt and cookie clearing.
  const MANUAL = new Set(['ready', 'authenticate', 'clearCookies']);
  const post = (message) => {
    const parsed = JSON.parse(message);
    posted.push(parsed);
    if (!MANUAL.has(parsed.cmd)) {
      queueMicrotask(() => window.MeroShellChannel.receive({ type: 'result', id: parsed.id, ok: true, value: null }));
    }
  };
  if (transport === 'android') {
    window.MeroShellNative = { postMessage: post };
  } else {
    window.webkit = { messageHandlers: { meroShell: { postMessage: post } } };
  }
  window.window = window;
  const context = vm.createContext(window);
  for (const src of scriptOrder(html)) {
    vm.runInContext(fs.readFileSync(path.join(shellDir, src), 'utf8'), context, { filename: src });
  }
  const native = {
    posted,
    last: () => posted[posted.length - 1],
    cmds: () => posted.map((m) => m.cmd),
    async reply(cmd, value) {
      const message = [...posted].reverse().find((m) => m.cmd === cmd);
      assert.ok(message, `no ${cmd} command was posted`);
      window.MeroShellChannel.receive({ type: 'result', id: message.id, ok: true, value });
      await flush();
    },
    async replyError(cmd, error) {
      const message = [...posted].reverse().find((m) => m.cmd === cmd);
      window.MeroShellChannel.receive({ type: 'result', id: message.id, ok: false, error });
      await flush();
    },
    async event(name, payload) {
      window.MeroShellChannel.receive(JSON.stringify({ type: 'event', name, payload }));
      await flush();
    },
  };
  return { document, window, native };
}

const button = (document, action) => document.querySelector(`[data-action="${action}"]`);
const field = (document, view, name) =>
  document.querySelector(`[data-view="${view}"]`).querySelector(`[data-field="${name}"]`).textContent;

test('the page boots behind the boot screen and first asks the native side for launch state', () => {
  const { document, native } = boot();
  assert.equal(document.visibleView(), 'boot');
  assert.deepEqual(native.posted, [{ id: 1, cmd: 'ready', args: {} }]);
});

test('the iOS message handler transport carries the same protocol', () => {
  const { native } = boot('ios');
  assert.deepEqual(native.cmds(), ['ready']);
});

test('locked launch: lock screen, cancelled prompt, unlock by tap, reveal after load', async () => {
  const { document, native } = boot();
  await native.reply('ready', { ...LAUNCH, lockEnabled: true });
  assert.equal(document.visibleView(), 'lock');
  assert.equal(native.last().cmd, 'authenticate');
  await native.event('pageLoaded', { url: 'https://shop.example.com/' });
  assert.ok(!native.cmds().includes('reveal'));
  await native.reply('authenticate', { ok: false, code: 'cancelled' });
  assert.match(field(document, 'lock', 'lockMessage'), /cancelled/);
  assert.equal(native.cmds().filter((c) => c === 'authenticate').length, 1);
  document.tap(button(document, 'unlock'));
  await flush();
  assert.equal(native.last().cmd, 'authenticate');
  await native.reply('authenticate', { ok: true });
  assert.equal(native.last().cmd, 'reveal');
});

test('settings from the hosted page, then sign-out clears cookies before reloading', async () => {
  const { document, native } = boot();
  await native.reply('ready', LAUNCH);
  await native.event('pageLoaded', { url: 'https://shop.example.com/' });
  await native.event('openSettings', {});
  assert.equal(document.visibleView(), 'settings');
  assert.equal(native.last().cmd, 'cover');
  assert.equal(field(document, 'settings', 'host'), 'shop.example.com');
  assert.equal(field(document, 'settings', 'appVersion'), '1.4.0 (12)');
  assert.equal(field(document, 'settings', 'starterVersion'), '1.0.0');
  assert.equal(field(document, 'settings', 'lockLabel'), 'Face ID lock');
  document.tap(button(document, 'signOut'));
  await flush();
  assert.equal(native.last().cmd, 'clearCookies');
  await native.reply('clearCookies', null);
  assert.deepEqual(native.last(), { id: native.last().id, cmd: 'loadHost', args: { path: '/' } });
  assert.equal(document.visibleView(), 'boot');
});

test('turning the lock on from the settings toggle authenticates, then stores the setting', async () => {
  const { document, native } = boot();
  await native.reply('ready', LAUNCH);
  await native.event('openSettings', {});
  document.tap(document.getElementById('lock-toggle'));
  await flush();
  assert.equal(native.last().cmd, 'authenticate');
  await native.reply('authenticate', { ok: true });
  assert.deepEqual(native.last().args, { enabled: true });
  assert.equal(native.last().cmd, 'setLockEnabled');
  assert.equal(document.getElementById('lock-toggle').checked, true);
});

test('offline screen, retry by tap without any Capacitor plugin, recovery on load', async () => {
  const { document, window, native } = boot();
  assert.equal(window.Capacitor, undefined);
  await native.reply('ready', LAUNCH);
  await native.event('pageFailed', { url: 'https://shop.example.com/cart', code: 'offline' });
  assert.equal(document.visibleView(), 'offline');
  document.tap(button(document, 'retry'));
  await flush();
  assert.deepEqual(native.last().args, { path: '/cart' });
  assert.equal(button(document, 'retry').disabled, true);
  await native.event('pageLoaded', { url: 'https://shop.example.com/cart' });
  assert.equal(native.last().cmd, 'reveal');
});

test('safe-area insets style the overlay and are forwarded to the hosted page', async () => {
  const { document, native } = boot();
  await native.reply('ready', LAUNCH);
  await native.event('insets', { top: 24, right: 0, bottom: 16, left: 0 });
  const style = document.documentElement.style;
  assert.equal(style.getPropertyValue('--meroshell-safe-area-inset-top'), '24px');
  assert.equal(style.getPropertyValue('--meroshell-safe-area-inset-bottom'), '16px');
  assert.deepEqual(native.last(), { id: native.last().id, cmd: 'applyHostInsets', args: { top: 24, right: 0, bottom: 16, left: 0 } });
});

test('a deep link off the application host never reaches the native WebView', async () => {
  const { native } = boot();
  await native.reply('ready', LAUNCH);
  await native.event('deepLink', { url: 'https://shop.example.com.evil.com/x' });
  await native.event('deepLink', { url: 'https://shop.example.com/x' });
  assert.deepEqual(
    native.posted.filter((m) => m.cmd === 'loadHost').map((m) => m.args.path),
    ['/x'],
  );
});

test('the overlay boots from the assembled www/meroshell/ in both modes, beside a bundled site', async () => {
  const { prepareWeb } = require('../lib/web-assets.cjs');
  const { tempDir } = require('./helpers/temp.cjs');
  for (const [mode, transport] of [['remote', 'ios'], ['bundled', 'android']]) {
    const dir = tempDir('meroshell-boot-');
    fs.cpSync(SHELL, path.join(dir, 'shell'), { recursive: true });
    const starter = { host: 'shop.example.com', appId: 'com.example.shop', appName: 'Shop', mode };
    if (mode === 'bundled') {
      starter.site = 'site';
      fs.mkdirSync(path.join(dir, 'site'));
      fs.writeFileSync(path.join(dir, 'site', 'index.html'), '<!doctype html><title>Shop</title>');
    }
    fs.writeFileSync(path.join(dir, 'starter.config.json'), JSON.stringify(starter));
    prepareWeb({ rootDir: dir });
    const { document, native } = boot(transport, path.join(dir, 'www', 'meroshell'));
    assert.deepEqual(native.cmds(), ['ready'], mode);
    await native.reply('ready', { ...LAUNCH, platform: transport, mode });
    await native.event('openSettings', {});
    assert.equal(document.visibleView(), 'settings');
    assert.equal(field(document, 'settings', 'host'), 'shop.example.com', `${mode}: settings name the application host`);
  }
});
