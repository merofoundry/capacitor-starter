'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { install, INSET_PROPERTIES } = require('../shell/hosted-integration.js');

const CONFIG = { host: 'shop.example.com', platform: 'ios', starterVersion: '1.0.0' };

function fakeWindow({ href = 'https://shop.example.com/', capacitor = true, share = undefined } = {}) {
  const url = new URL(href);
  const props = new Map();
  const classes = new Set();
  const attrs = new Map();
  const listeners = {};
  const dispatched = [];
  const nativeCalls = [];
  const win = {
    location: { protocol: url.protocol, hostname: url.hostname, href: url.href },
    navigator: share ? { share } : {},
    document: {
      title: 'Shop',
      documentElement: {
        style: {
          setProperty: (name, value) => props.set(name, value),
          getPropertyValue: (name) => props.get(name) || '',
        },
        classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) },
        setAttribute: (k, v) => attrs.set(k, v),
      },
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
    },
    dispatchEvent: (event) => dispatched.push(event.type),
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
  };
  if (capacitor) {
    win.Capacitor = {
      nativePromise: (plugin, method, options) => {
        nativeCalls.push([plugin, method, options]);
        return Promise.resolve({});
      },
    };
  }
  return { win, props, classes, attrs, listeners, dispatched, nativeCalls };
}

function click(listeners, dataset) {
  const el = { dataset };
  const target = { closest: (selector) => (selector === '[data-meroshell-action]' ? el : null) };
  let prevented = false;
  listeners.click({ target, preventDefault: () => (prevented = true) });
  return prevented;
}

test('installs only on the configured https host', () => {
  assert.equal(install(fakeWindow({ href: 'https://evil.example.com/' }).win, CONFIG), null);
  assert.equal(install(fakeWindow({ href: 'http://shop.example.com/' }).win, CONFIG), null);
  assert.equal(install(fakeWindow().win, null), null);
  assert.ok(install(fakeWindow().win, CONFIG));
});

test('marks the document so the hosted site can adapt to the shell', () => {
  const { win, classes, attrs, dispatched } = fakeWindow();
  const api = install(win, CONFIG);
  assert.ok(classes.has('meroshell'));
  assert.equal(attrs.get('data-meroshell-platform'), 'ios');
  assert.equal(api.version, '1.0.0');
  assert.equal(api.host, 'shop.example.com');
  assert.equal(win.MeroFoundryShell, api);
  assert.deepEqual(dispatched, ['meroshell:ready']);
});

test('installing twice returns the same API', () => {
  const { win } = fakeWindow();
  assert.equal(install(win, CONFIG), install(win, CONFIG));
});

test('safe-area variables default to env() and take native pixel values when applied', () => {
  const { win, props } = fakeWindow();
  const api = install(win, CONFIG);
  assert.equal(props.get(INSET_PROPERTIES.top), 'env(safe-area-inset-top, 0px)');
  assert.equal(props.get(INSET_PROPERTIES.left), 'env(safe-area-inset-left, 0px)');
  api._applyInsets({ top: 47, right: 0, bottom: 34, left: 0 });
  assert.equal(props.get(INSET_PROPERTIES.top), '47px');
  assert.equal(props.get(INSET_PROPERTIES.bottom), '34px');
  assert.equal(props.get(INSET_PROPERTIES.right), '0px');
});

test('share, haptics, status bar and settings go to the official plugins through the Capacitor bridge', async () => {
  const { win, nativeCalls } = fakeWindow();
  const api = install(win, CONFIG);
  await api.share({ title: 'Order', url: 'https://shop.example.com/o/1' });
  await api.haptic('MEDIUM');
  await api.setStatusBarStyle('DARK');
  await api.openSettings();
  assert.deepEqual(nativeCalls, [
    ['Share', 'share', { title: 'Order', url: 'https://shop.example.com/o/1' }],
    ['Haptics', 'impact', { style: 'MEDIUM' }],
    ['StatusBar', 'setStyle', { style: 'DARK' }],
    ['MeroShell', 'openSettings', {}],
  ]);
});

test('unknown haptic and status-bar styles are rejected before reaching native code', async () => {
  const { win, nativeCalls } = fakeWindow();
  const api = install(win, CONFIG);
  await assert.rejects(api.haptic('EXPLODE'), /haptic style/);
  await assert.rejects(api.setStatusBarStyle('NEON'), /status bar style/);
  assert.equal(nativeCalls.length, 0);
});

test('navigator.share is provided through the Share plugin when the WebView lacks it', async () => {
  const { win, nativeCalls } = fakeWindow();
  install(win, CONFIG);
  await win.navigator.share({ title: 'T', text: 'x', url: 'https://shop.example.com/' });
  assert.deepEqual(nativeCalls, [['Share', 'share', { title: 'T', text: 'x', url: 'https://shop.example.com/' }]]);
});

test('an existing navigator.share is left alone', () => {
  const original = () => Promise.resolve();
  const { win } = fakeWindow({ share: original });
  install(win, CONFIG);
  assert.equal(win.navigator.share, original);
});

test('data-meroshell-action elements open settings, share and trigger haptics', () => {
  const { win, listeners, nativeCalls } = fakeWindow({ href: 'https://shop.example.com/item/3' });
  install(win, CONFIG);
  assert.equal(click(listeners, { meroshellAction: 'settings' }), true);
  click(listeners, { meroshellAction: 'share' });
  click(listeners, { meroshellAction: 'share', meroshellShareUrl: 'https://shop.example.com/x', meroshellShareTitle: 'X' });
  click(listeners, { meroshellAction: 'haptic', meroshellHaptic: 'HEAVY' });
  assert.deepEqual(nativeCalls, [
    ['MeroShell', 'openSettings', {}],
    ['Share', 'share', { title: 'Shop', url: 'https://shop.example.com/item/3' }],
    ['Share', 'share', { title: 'X', url: 'https://shop.example.com/x' }],
    ['Haptics', 'impact', { style: 'HEAVY' }],
  ]);
});

test('without the Capacitor bridge the calls fail cleanly instead of throwing', async () => {
  const { win } = fakeWindow({ capacitor: false });
  const api = install(win, CONFIG);
  await assert.rejects(api.openSettings(), /Capacitor bridge/);
});
