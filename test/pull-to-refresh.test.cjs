'use strict';

/*
 * Pull to refresh, end to end through the starter's own code: the gesture recogniser in
 * shell/hosted-integration.js, the MeroShell `refresh` call it makes, and the controller's
 * refreshRequested decision. The native forwarder between them is modelled by routing the
 * hosted page's MeroShell.refresh call into controller.handleEvent('refreshRequested'), which
 * is what MeroShellPlugin.java and MeroShellPlugin.swift do (read as text in
 * native-contract.test.cjs). No WebView, touch screen or device runs here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { install, PULL_THRESHOLD } = require('../shell/hosted-integration.js');
const { createController } = require('../shell/controller.js');
const { FakeNative, FakeView, flush } = require('./helpers/doubles.cjs');

const CONFIG = { host: 'shop.example.com', platform: 'android', starterVersion: '1.0.0' };

function element({ scrollTop = 0, parent = null, optOut = false } = {}) {
  const el = {
    nodeType: 1,
    scrollTop,
    parentElement: parent,
    optOut,
    closest(selector) {
      assert.equal(selector, '[data-meroshell-pull-refresh="off"]');
      for (let node = el; node; node = node.parentElement) {
        if (node.optOut) {
          return node;
        }
      }
      return null;
    },
  };
  return el;
}

/** A hosted page on the application host whose MeroShell calls go to `onNative`. */
function hostedPage({ href = 'https://shop.example.com/orders?page=2', onNative } = {}) {
  const listeners = {};
  const attrs = new Map();
  const props = new Map();
  const nativeCalls = [];
  const body = element();
  const scroller = { scrollTop: 0 };
  const win = {
    scrollY: 0,
    location: { protocol: 'https:', hostname: new URL(href).hostname, href },
    navigator: {},
    document: {
      title: 'Shop',
      visibilityState: 'visible',
      scrollingElement: scroller,
      documentElement: {
        style: { setProperty: (name, value) => props.set(name, value) },
        classList: { add() {} },
        setAttribute: (k, v) => attrs.set(k, v),
        removeAttribute: (k) => attrs.delete(k),
      },
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
    },
    Capacitor: {
      nativePromise: (plugin, method, options) => {
        nativeCalls.push([plugin, method, options]);
        return onNative ? onNative(plugin, method, options) : Promise.resolve({});
      },
    },
  };
  install(win, CONFIG);
  const touch = (type, points, target = body) =>
    listeners[type]({ target, touches: points.map(([x, y]) => ({ clientX: x, clientY: y })) });
  /** One finger from (100, 50) straight down by `dy`, or along `path`, then lifted. */
  function pull(dy = PULL_THRESHOLD + 10, { target = body, path = [[100, 50 + dy]] } = {}) {
    touch('touchstart', [[100, 50]], target);
    for (const point of path) {
      touch('touchmove', [point], target);
    }
    touch('touchend', [], target);
  }
  const refreshes = () => nativeCalls.filter(([p, m]) => p === 'MeroShell' && m === 'refresh');
  return { win, listeners, attrs, props, nativeCalls, body, scroller, touch, pull, refreshes };
}

// Triggering

test('a pull past the threshold at the top of the page asks the shell to refresh this page', () => {
  const page = hostedPage();
  page.pull();
  assert.deepEqual(page.refreshes(), [['MeroShell', 'refresh', { url: 'https://shop.example.com/orders?page=2' }]]);
});

test('a pull that stops short of the threshold does nothing', () => {
  const page = hostedPage();
  page.pull(PULL_THRESHOLD - 1);
  assert.equal(page.refreshes().length, 0);
});

test('pulling past the threshold and back before lifting does not refresh', () => {
  const page = hostedPage();
  page.pull(0, { path: [[100, 50 + PULL_THRESHOLD + 20], [100, 60]] });
  assert.equal(page.refreshes().length, 0);
});

test('arming gives one light haptic through the official Haptics plugin', () => {
  const page = hostedPage();
  page.pull(0, { path: [[100, 90], [100, 50 + PULL_THRESHOLD], [100, 50 + PULL_THRESHOLD + 30]] });
  const haptics = page.nativeCalls.filter(([p]) => p === 'Haptics');
  assert.deepEqual(haptics, [['Haptics', 'impact', { style: 'LIGHT' }]]);
});

test('the pull distance and state are exposed for the site to style, and cleared afterwards', async () => {
  let finish;
  const page = hostedPage({ onNative: (p) => (p === 'MeroShell' ? new Promise((r) => (finish = r)) : Promise.resolve()) });
  page.touch('touchstart', [[100, 50]]);
  page.touch('touchmove', [[100, 80]]);
  assert.equal(page.attrs.get('data-meroshell-pull'), 'pulling');
  assert.equal(page.props.get('--meroshell-pull-distance'), '30px');
  page.touch('touchmove', [[100, 50 + PULL_THRESHOLD]]);
  assert.equal(page.attrs.get('data-meroshell-pull'), 'armed');
  page.touch('touchend', []);
  assert.equal(page.attrs.get('data-meroshell-pull'), 'refreshing');
  assert.equal(page.props.get('--meroshell-pull-distance'), '0px');
  finish({});
  await flush();
  assert.equal(page.attrs.has('data-meroshell-pull'), false);
});

test('a second pull while a refresh is in flight is ignored', async () => {
  let finish;
  const page = hostedPage({ onNative: (p) => (p === 'MeroShell' ? new Promise((r) => (finish = r)) : Promise.resolve()) });
  page.pull();
  page.pull();
  assert.equal(page.refreshes().length, 1);
  finish({});
  await flush();
  page.pull();
  assert.equal(page.refreshes().length, 2);
});

test('without the Capacitor bridge a pull fails quietly and the gesture is usable again', async () => {
  const page = hostedPage({ onNative: () => Promise.reject(new Error('Capacitor bridge unavailable')) });
  page.pull();
  await flush();
  assert.equal(page.attrs.has('data-meroshell-pull'), false);
  page.pull();
  assert.equal(page.refreshes().length, 2);
});

// Scroll and gesture eligibility

test('a pull is not eligible when the page is scrolled down', () => {
  const page = hostedPage();
  page.scroller.scrollTop = 1;
  page.pull();
  page.scroller.scrollTop = 0;
  page.win.scrollY = 5;
  page.pull();
  assert.equal(page.refreshes().length, 0);
});

test('iOS rubber-band overscroll at the top (negative scrollY) still counts as the top', () => {
  const page = hostedPage();
  page.win.scrollY = -40;
  page.pull();
  assert.equal(page.refreshes().length, 1);
});

test('a pull inside a scrolled inner element scrolls that element instead', () => {
  const page = hostedPage();
  const list = element({ scrollTop: 120, parent: page.body });
  page.pull(PULL_THRESHOLD + 10, { target: element({ parent: list }) });
  assert.equal(page.refreshes().length, 0);
  const atTop = element({ scrollTop: 0, parent: page.body });
  page.pull(PULL_THRESHOLD + 10, { target: element({ parent: atTop }) });
  assert.equal(page.refreshes().length, 1);
});

test('elements marked data-meroshell-pull-refresh="off" opt out of the gesture', () => {
  const page = hostedPage();
  const map = element({ parent: page.body, optOut: true });
  page.pull(PULL_THRESHOLD + 10, { target: element({ parent: map }) });
  assert.equal(page.refreshes().length, 0);
});

test('a page that starts scrolling during the pull cancels it', () => {
  const page = hostedPage();
  page.touch('touchstart', [[100, 50]]);
  page.touch('touchmove', [[100, 90]]);
  page.scroller.scrollTop = 10;
  page.touch('touchmove', [[100, 50 + PULL_THRESHOLD + 10]]);
  page.touch('touchend', []);
  assert.equal(page.refreshes().length, 0);
});

test('multi-touch, sideways swipes, upward swipes and cancelled touches do not refresh', () => {
  const page = hostedPage();
  page.touch('touchstart', [[100, 50], [200, 50]]);
  page.touch('touchmove', [[100, 200], [200, 200]]);
  page.touch('touchend', []);
  page.pull(0, { path: [[200, 70], [100 + PULL_THRESHOLD * 2, 50 + PULL_THRESHOLD + 10]] });
  page.pull(0, { path: [[100, 20], [100, 50 + PULL_THRESHOLD + 10]] });
  page.touch('touchstart', [[100, 50]]);
  page.touch('touchmove', [[100, 50 + PULL_THRESHOLD + 10]]);
  page.listeners.touchcancel({});
  page.touch('touchend', []);
  assert.equal(page.refreshes().length, 0);
});

test('a page in a hidden document does not start a pull', () => {
  const page = hostedPage();
  page.win.document.visibilityState = 'hidden';
  page.pull();
  assert.equal(page.refreshes().length, 0);
});

test('the gesture listeners are passive so the page keeps scrolling natively', () => {
  const options = [];
  const win = hostedPage().win;
  win.MeroFoundryShell = undefined;
  win.document.addEventListener = (type, fn, opts) => options.push([type, opts]);
  install(win, CONFIG);
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    assert.deepEqual(options.find(([t]) => t === type)[1], { passive: true, capture: true }, type);
  }
});

// Through the controller: reload, lock suppression and offline recovery

/** The hosted page and the overlay controller wired as the native forwarder wires them. */
async function shell(launch, prepare = () => {}) {
  const native = new FakeNative(launch);
  prepare(native);
  const view = new FakeView();
  const controller = createController({ native, view });
  const page = hostedPage({
    onNative: (plugin, method, options) => {
      if (plugin === 'MeroShell' && method === 'refresh') {
        controller.handleEvent('refreshRequested', { url: options.url });
      }
      return Promise.resolve({});
    },
  });
  await controller.start();
  await flush();
  const loads = () => native.calls.filter((c) => c.cmd === 'loadHost').map((c) => c.args.path);
  return { native, view, controller, page, loads };
}

async function shown(launch) {
  const s = await shell(launch);
  await s.controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  await flush();
  assert.equal(s.native.commands().at(-1), 'reveal');
  return s;
}

test('a pull on the shown page reloads that page from the configured host, without covering it', async () => {
  const { native, page, loads } = await shown();
  const covers = native.count('cover');
  page.pull();
  await flush();
  assert.deepEqual(loads(), ['/orders?page=2']);
  assert.equal(native.count('cover'), covers, 'the page stays visible while it reloads');
});

test('a refresh request naming another host reloads the application host root instead', async () => {
  const { controller, loads } = await shown();
  await controller.handleEvent('refreshRequested', { url: 'https://evil.example.com/steal' });
  await controller.handleEvent('refreshRequested', {});
  assert.deepEqual(loads(), ['/', '/']);
});

test('a pull while the lock screen is shown is suppressed', async () => {
  const { native, controller, page, loads } = await shell({ lockEnabled: true });
  native.hold('authenticate');
  await controller.handleEvent('resume', { backgrounded: true });
  await controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  page.pull();
  await flush();
  assert.deepEqual(loads(), []);
  await native.release('authenticate', { ok: true });
  page.pull();
  await flush();
  assert.deepEqual(loads(), ['/orders?page=2'], 'refresh works again once unlocked');
});

test('a pull that races a lock on resume is suppressed', async () => {
  const { native, controller, page, loads } = await shown({ lockEnabled: true });
  native.hold('authenticate');
  await controller.handleEvent('resume', { backgrounded: true });
  page.pull();
  await flush();
  assert.equal(native.calls.at(-1).cmd, 'authenticate', 'the lock prompt is pending');
  assert.deepEqual(loads(), []);
});

test('a failed unlock keeps refresh suppressed', async () => {
  const { controller, view, loads } = await shell({ lockEnabled: true }, (native) =>
    native.answer('authenticate', () => ({ ok: false, code: 'cancelled' })));
  await controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  await controller.handleEvent('refreshRequested', { url: 'https://shop.example.com/' });
  assert.equal(view.current.name, 'lock');
  assert.deepEqual(loads(), []);
});

test('a pull is suppressed while settings or the offline screen cover the page', async () => {
  const { controller, loads } = await shown();
  await controller.handleEvent('openSettings', {});
  await controller.handleEvent('refreshRequested', { url: 'https://shop.example.com/' });
  await controller.act('closeSettings');
  await controller.handleEvent('pageFailed', { url: 'https://shop.example.com/' });
  await controller.handleEvent('refreshRequested', { url: 'https://shop.example.com/' });
  assert.deepEqual(loads(), []);
});

test('a refresh that cannot reach the host shows the offline screen, whose retry reloads the page', async () => {
  const { native, view, controller, page, loads } = await shown();
  page.pull();
  await flush();
  assert.deepEqual(loads(), ['/orders?page=2']);
  await controller.handleEvent('pageFailed', { url: 'https://shop.example.com/orders?page=2', code: -2 });
  assert.equal(view.current.name, 'offline');
  assert.equal(view.current.data.status, 'failed');
  assert.equal(native.commands().at(-1), 'cover');
  await controller.act('retry');
  assert.deepEqual(loads(), ['/orders?page=2', '/orders?page=2']);
  assert.equal(view.shown.at(-1).data.status, 'retrying');
  await controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/orders?page=2' });
  assert.equal(native.commands().at(-1), 'reveal');
  page.pull();
  await flush();
  assert.equal(loads().length, 3, 'refresh is available again after recovery');
});
