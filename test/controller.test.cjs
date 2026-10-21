'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createController } = require('../shell/controller.js');
const { FakeNative, FakeView, flush } = require('./helpers/doubles.cjs');

function setup(launch) {
  const native = new FakeNative(launch);
  const view = new FakeView();
  const controller = createController({ native, view });
  return { native, view, controller };
}

async function started(launch) {
  const s = setup(launch);
  await s.controller.start();
  await flush();
  return s;
}

async function revealed(launch) {
  const s = await started(launch);
  s.controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  await flush();
  assert.equal(s.native.commands().at(-1), 'reveal');
  return s;
}

// Initialization ordering

test('the boot view is shown before the native side is asked for launch state', async () => {
  const { native, view, controller } = setup();
  native.hold('ready');
  const starting = controller.start();
  assert.deepEqual(view.shown.map((v) => v.name), ['boot']);
  assert.deepEqual(native.commands(), ['ready']);
  await native.release('ready', native.launch);
  await starting;
});

test('events delivered before launch state is known wait for it, then apply in order', async () => {
  const { native, controller } = setup();
  native.hold('ready');
  const starting = controller.start();
  controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  controller.handleEvent('deepLink', { url: 'https://shop.example.com/orders/7' });
  await flush();
  assert.deepEqual(native.commands(), ['ready'], 'nothing acts before launch state');
  await native.release('ready', native.launch);
  await starting;
  await flush();
  assert.deepEqual(native.commands(), ['ready', 'loadHost', 'reveal']);
  assert.deepEqual(native.calls[1].args, { path: '/orders/7' });
});

test('the hosted page is revealed only once it has loaded', async () => {
  const { native, controller } = await started();
  assert.equal(native.count('reveal'), 0);
  controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  await flush();
  assert.equal(native.count('reveal'), 1);
});

test('without a lock the shell never asks for authentication', async () => {
  const { native } = await revealed({ lockEnabled: false });
  assert.equal(native.count('authenticate'), 0);
});

// Lock before display

test('with the lock on, a loaded page stays hidden until authentication succeeds', async () => {
  const { native, view, controller } = setup({ lockEnabled: true });
  native.hold('authenticate');
  await controller.start();
  controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  await flush();
  assert.equal(view.current.name, 'lock');
  assert.equal(native.count('reveal'), 0);
  await native.release('authenticate', { ok: true });
  assert.equal(native.count('reveal'), 1);
  assert.ok(native.indexOf('authenticate') < native.indexOf('reveal'));
});

test('unlocking before the page has loaded keeps the boot view until it loads', async () => {
  const { native, view, controller } = await started({ lockEnabled: true });
  assert.equal(native.count('reveal'), 0);
  assert.equal(view.current.name, 'boot');
  controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  await flush();
  assert.equal(native.count('reveal'), 1);
});

// Resume locking

test('resuming from the background with the lock on locks and re-authenticates', async () => {
  const { native, view, controller } = await revealed({ lockEnabled: true });
  native.hold('authenticate');
  const before = native.count('reveal');
  controller.handleEvent('resume', { backgrounded: true });
  await flush();
  assert.equal(view.current.name, 'lock');
  assert.equal(native.commands().at(-1), 'authenticate');
  assert.ok(native.commands().lastIndexOf('cover') > native.commands().lastIndexOf('reveal'));
  assert.equal(native.count('reveal'), before);
  await native.release('authenticate', { ok: true });
  assert.equal(native.count('reveal'), before + 1);
});

test('a privacy cover without backgrounding is lifted without authentication', async () => {
  const { native, controller } = await revealed({ lockEnabled: true });
  const auths = native.count('authenticate');
  controller.handleEvent('resume', { backgrounded: false });
  await flush();
  assert.equal(native.count('authenticate'), auths);
  assert.equal(native.commands().at(-1), 'reveal');
});

test('resume with the lock off does not authenticate', async () => {
  const { native, controller } = await revealed({ lockEnabled: false });
  controller.handleEvent('resume', { backgrounded: true });
  await flush();
  assert.equal(native.count('authenticate'), 0);
});

test('a resume while authentication is in flight does not prompt twice', async () => {
  const { native, controller } = setup({ lockEnabled: true });
  native.hold('authenticate');
  await controller.start();
  controller.handleEvent('resume', { backgrounded: true });
  controller.handleEvent('resume', { backgrounded: false });
  await flush();
  assert.equal(native.count('authenticate'), 1);
  await native.release('authenticate', { ok: true });
});

// Authentication failure and cancellation

test('a failed authentication keeps the shell locked and offers a retry', async () => {
  const { native, view, controller } = setup({ lockEnabled: true });
  native.answer('authenticate', () => ({ ok: false, code: 'failed', message: 'Not recognised' }));
  await controller.start();
  controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  await flush();
  assert.equal(native.count('reveal'), 0);
  assert.equal(view.current.name, 'lock');
  assert.equal(view.current.data.status, 'failed');
  native.answer('authenticate', () => ({ ok: true }));
  await controller.act('unlock');
  await flush();
  assert.equal(native.count('authenticate'), 2);
  assert.equal(native.count('reveal'), 1);
});

test('a cancelled authentication stays locked and does not re-prompt by itself', async () => {
  const { native, view, controller } = setup({ lockEnabled: true });
  native.answer('authenticate', () => ({ ok: false, code: 'cancelled' }));
  await controller.start();
  controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  await flush();
  assert.equal(view.current.name, 'lock');
  assert.equal(view.current.data.status, 'cancelled');
  assert.equal(native.count('authenticate'), 1);
  assert.equal(native.count('reveal'), 0);
});

test('an authentication error from the native side is treated as a failure, not an unlock', async () => {
  const { native, view, controller } = setup({ lockEnabled: true });
  native.hold('authenticate');
  await controller.start();
  controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  await flush();
  await native.fail('authenticate', new Error('prompt crashed'));
  assert.equal(view.current.name, 'lock');
  assert.equal(view.current.data.status, 'failed');
  assert.equal(native.count('reveal'), 0);
});

test('biometrics unavailable on a locked device keeps it locked with an explanation', async () => {
  const { native, view, controller } = setup({ lockEnabled: true });
  native.answer('authenticate', () => ({ ok: false, code: 'unavailable' }));
  await controller.start();
  controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  await flush();
  assert.equal(view.current.name, 'lock');
  assert.equal(view.current.data.status, 'unavailable');
  assert.equal(native.count('reveal'), 0);
});

// Settings access

test('settings opened from the hosted page cover it and show host and versions', async () => {
  const { native, view, controller } = await revealed();
  controller.handleEvent('openSettings', {});
  await flush();
  assert.equal(view.current.name, 'settings');
  assert.equal(native.commands().at(-1), 'cover');
  assert.equal(view.current.data.host, 'shop.example.com');
  assert.equal(view.current.data.appVersion, '1.4.0 (12)');
  assert.equal(view.current.data.starterVersion, '1.0.0');
  assert.equal(view.current.data.lockEnabled, false);
  await controller.act('closeSettings');
  await flush();
  assert.equal(native.commands().at(-1), 'reveal');
});

test('settings requested while locked are shown only after unlocking', async () => {
  const { native, view, controller } = setup({ lockEnabled: true });
  native.hold('authenticate');
  await controller.start();
  controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  controller.handleEvent('openSettings', {});
  await flush();
  assert.equal(view.current.name, 'lock');
  await native.release('authenticate', { ok: true });
  assert.equal(view.current.name, 'settings');
  assert.equal(native.count('reveal'), 0);
});

test('turning the lock on requires a successful authentication first', async () => {
  const { native, view, controller } = await revealed();
  controller.handleEvent('openSettings', {});
  native.answer('authenticate', () => ({ ok: false, code: 'cancelled' }));
  await controller.act('setLock', { enabled: true });
  assert.equal(native.count('setLockEnabled'), 0);
  assert.equal(view.current.data.lockEnabled, false);
  native.answer('authenticate', () => ({ ok: true }));
  await controller.act('setLock', { enabled: true });
  assert.deepEqual(native.calls.at(-1), { cmd: 'setLockEnabled', args: { enabled: true } });
  assert.equal(view.current.data.lockEnabled, true);
  controller.handleEvent('resume', { backgrounded: true });
  await flush();
  assert.equal(native.commands().at(-1), 'authenticate');
});

test('the lock cannot be turned on when the device has no biometrics or passcode', async () => {
  const { native, view, controller } = await revealed({ biometry: { available: false, kind: 'none' } });
  controller.handleEvent('openSettings', {});
  await controller.act('setLock', { enabled: true });
  assert.equal(native.count('authenticate'), 0);
  assert.equal(native.count('setLockEnabled'), 0);
  assert.equal(view.current.data.lockAvailable, false);
});

test('turning the lock off is stored on the device', async () => {
  const { native, view, controller } = await revealed({ lockEnabled: true });
  controller.handleEvent('openSettings', {});
  await controller.act('setLock', { enabled: false });
  assert.deepEqual(native.calls.at(-1), { cmd: 'setLockEnabled', args: { enabled: false } });
  assert.equal(view.current.data.lockEnabled, false);
});

// Offline retry

test('a failed main-frame load shows the offline view and retry reloads the failed path', async () => {
  const { native, view, controller } = await revealed();
  assert.equal(globalThis.Capacitor, undefined, 'no Capacitor plugin bridge in the overlay');
  controller.handleEvent('pageFailed', { url: 'https://shop.example.com/orders?page=2', code: 'offline' });
  await flush();
  assert.equal(view.current.name, 'offline');
  assert.equal(native.commands().at(-1), 'cover');
  await controller.act('retry');
  assert.deepEqual(native.calls.at(-1), { cmd: 'loadHost', args: { path: '/orders?page=2' } });
  assert.equal(view.current.data.status, 'retrying');
  controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/orders?page=2' });
  await flush();
  assert.equal(native.commands().at(-1), 'reveal');
});

test('retry after a failure off the configured host reloads the host root', async () => {
  const { native, controller } = await started();
  controller.handleEvent('pageFailed', { url: 'https://elsewhere.example.net/', code: 'offline' });
  await controller.act('retry');
  assert.deepEqual(native.calls.at(-1), { cmd: 'loadHost', args: { path: '/' } });
});

test('a failed retry returns to the offline view', async () => {
  const { view, controller } = await started();
  controller.handleEvent('pageFailed', { url: 'https://shop.example.com/', code: 'offline' });
  await controller.act('retry');
  controller.handleEvent('pageFailed', { url: 'https://shop.example.com/', code: 'offline' });
  await flush();
  assert.equal(view.current.name, 'offline');
  assert.equal(view.current.data.status, 'failed');
});

test('settings are reachable from the offline view', async () => {
  const { view, controller } = await started();
  controller.handleEvent('pageFailed', { url: 'https://shop.example.com/', code: 'offline' });
  await controller.act('openSettings');
  assert.equal(view.current.name, 'settings');
  await controller.act('closeSettings');
  assert.equal(view.current.name, 'offline');
});

// Sign-out

test('sign-out clears the WebView cookies before reloading the host', async () => {
  const { native, view, controller } = await revealed();
  controller.handleEvent('openSettings', {});
  native.hold('clearCookies');
  const signingOut = controller.act('signOut');
  await flush();
  assert.equal(native.commands().at(-1), 'clearCookies');
  assert.equal(native.count('loadHost'), 0, 'no reload until cookies are cleared');
  await native.release('clearCookies');
  await signingOut;
  const cmds = native.commands();
  assert.ok(cmds.lastIndexOf('clearCookies') < cmds.lastIndexOf('loadHost'));
  assert.deepEqual(native.calls.at(-1), { cmd: 'loadHost', args: { path: '/' } });
  assert.equal(view.current.name, 'boot');
  controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  await flush();
  assert.equal(native.commands().at(-1), 'reveal');
});

test('if clearing cookies fails the host is not reloaded and the error is shown', async () => {
  const { native, view, controller } = await revealed();
  controller.handleEvent('openSettings', {});
  native.hold('clearCookies');
  const signingOut = controller.act('signOut');
  await flush();
  await native.fail('clearCookies', new Error('cookie store unavailable'));
  await signingOut;
  assert.equal(native.count('loadHost'), 0);
  assert.equal(view.current.name, 'settings');
  assert.match(view.current.data.error, /cookie/i);
});

test('sign-out leaves the device lock setting unchanged', async () => {
  const { native, controller } = await revealed({ lockEnabled: true });
  controller.handleEvent('openSettings', {});
  await controller.act('signOut');
  assert.equal(native.count('setLockEnabled'), 0);
});

// Safe areas

test('safe-area insets reach the overlay and the hosted page, and are re-sent after each load', async () => {
  const { native, view, controller } = await started();
  const insets = { top: 47, right: 0, bottom: 34, left: 0 };
  controller.handleEvent('insets', insets);
  await flush();
  assert.deepEqual(view.insets.at(-1), insets);
  assert.deepEqual(native.calls.at(-1), { cmd: 'applyHostInsets', args: insets });
  controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/next' });
  await flush();
  const applied = native.calls.filter((c) => c.cmd === 'applyHostInsets');
  assert.equal(applied.length, 2);
  assert.deepEqual(applied[1].args, insets);
});

test('malformed insets are ignored', async () => {
  const { native, view, controller } = await started();
  controller.handleEvent('insets', { top: 'x' });
  await flush();
  assert.equal(view.insets.length, 0);
  assert.equal(native.count('applyHostInsets'), 0);
});

// Deep links

test('a deep link on the configured host navigates the hosted WebView to its path', async () => {
  const { native, controller } = await revealed();
  controller.handleEvent('deepLink', { url: 'https://shop.example.com/products/9?ref=mail' });
  await flush();
  assert.deepEqual(native.calls.at(-1), { cmd: 'loadHost', args: { path: '/products/9?ref=mail' } });
  assert.equal(native.count('cover'), 0, 'a visible page is navigated in place, not covered');
});

test('a deep link to any other host is ignored', async () => {
  const { native, controller } = await revealed();
  for (const url of ['https://evil.example.com/', 'http://shop.example.com/', 'https://shop.example.com.evil.com/']) {
    controller.handleEvent('deepLink', { url });
  }
  await flush();
  assert.equal(native.count('loadHost'), 0);
});

test('a deep link that arrives while locked loads behind the lock and is shown after unlock', async () => {
  const { native, controller } = setup({ lockEnabled: true });
  native.hold('authenticate');
  await controller.start();
  controller.handleEvent('deepLink', { url: 'https://shop.example.com/inbox' });
  await flush();
  assert.deepEqual(native.calls.at(-1).cmd, 'loadHost');
  controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/inbox' });
  await flush();
  assert.equal(native.count('reveal'), 0);
  await native.release('authenticate', { ok: true });
  assert.equal(native.count('reveal'), 1);
});

test('the deep-link host is the host the native side reports, not a hard-coded one', async () => {
  const { native, controller } = await revealed({ host: 'preview-shop.example.com' });
  controller.handleEvent('deepLink', { url: 'https://shop.example.com/a' });
  controller.handleEvent('deepLink', { url: 'https://preview-shop.example.com/b' });
  await flush();
  assert.deepEqual(native.calls.filter((c) => c.cmd === 'loadHost').map((c) => c.args.path), ['/b']);
});
