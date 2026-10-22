'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { install, INSET_PROPERTIES } = require('../shell/hosted-integration.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

const CONFIG = { host: 'shop.example.com', platform: 'ios', starterVersion: '1.0.0' };
// The page's push methods are recorded apart from the calls the other tests assert on.
const PUSH_METHODS = ['getPushState', 'registerPush', 'unregisterPush', 'pushDisabled'];

function fakeWindow({ href = 'https://shop.example.com/', capacitor = true, share = undefined, providerSignIn = false, answers = {} } = {}) {
  const url = new URL(href);
  const props = new Map();
  const classes = new Set();
  const attrs = new Map();
  const listeners = {};
  const dispatched = [];
  const nativeCalls = [];
  const capabilityQueries = [];
  const pushCalls = [];
  const win = {
    location: { protocol: url.protocol, hostname: url.hostname, host: url.host, href: url.href },
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
        removeAttribute: (k) => attrs.delete(k),
      },
      addEventListener: (type, fn) => {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      removeEventListener: (type, fn) => {
        listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
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
    // The MeroShell capabilities query is recorded apart from the calls a test asserts on.
    win.Capacitor = {
      nativePromise: (plugin, method, options) => {
        if (plugin === 'MeroShell' && method === 'capabilities') {
          capabilityQueries.push(options);
          return Promise.resolve({ providerSignIn });
        }
        if (plugin === 'MeroShell' && PUSH_METHODS.includes(method)) {
          pushCalls.push([method, options]);
          const answer = answers[`${plugin}.${method}`];
          return answer ? answer(options) : Promise.resolve({});
        }
        nativeCalls.push([plugin, method, options]);
        const answer = answers[`${plugin}.${method}`];
        return answer ? answer(options) : Promise.resolve({});
      },
    };
  }
  return { win, props, classes, attrs, listeners, dispatched, nativeCalls, capabilityQueries, pushCalls };
}

/** Deliver a click on an element that matches only `selector` to every click listener. */
function clickOn(listeners, selector, el) {
  const target = { closest: (s) => (s === selector ? el : null) };
  let prevented = false;
  for (const fn of listeners.click || []) {
    fn({ target, preventDefault: () => (prevented = true) });
  }
  return prevented;
}

function click(listeners, dataset) {
  return clickOn(listeners, '[data-meroshell-action]', { dataset });
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

// Provider sign-in (ADR 2026-10-16 v2, Ruling 6)

const PROVIDER_LINK = 'https://shop.example.com/api/v1/services/9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a/inbound?provider=google';
const UNAVAILABLE = /Provider sign-in is not available in this app/;

function providerClick(listeners, href = PROVIDER_LINK) {
  return clickOn(listeners, '[data-provider-sign-in]', { href, getAttribute: (n) => (n === 'href' ? href : null) });
}

test('disabled support binds no provider click, sets no attribute and rejects providerSignIn', async () => {
  const { win, attrs, listeners, nativeCalls, capabilityQueries } = fakeWindow();
  const api = install(win, CONFIG);
  await flush();
  assert.equal(capabilityQueries.length, 1, 'the page asks the shell once at install');
  assert.equal(attrs.has('data-meroshell-provider-sign-in'), false);
  assert.equal(api.capabilities.providerSignIn, false);
  assert.equal(listeners.click.length, 1, 'only the data-meroshell-action listener');
  assert.equal(providerClick(listeners), false, 'the default navigation is left alone');
  await assert.rejects(api.providerSignIn(PROVIDER_LINK), UNAVAILABLE);
  assert.equal(nativeCalls.length, 0);
});

test('enabled support marks the document, reports true and forwards the href of a clicked provider link', async () => {
  const { win, attrs, listeners, nativeCalls, dispatched } = fakeWindow({ providerSignIn: true });
  const api = install(win, CONFIG);
  await flush();
  assert.equal(attrs.get('data-meroshell-provider-sign-in'), 'on');
  assert.equal(api.capabilities.providerSignIn, true);
  assert.ok(dispatched.includes('meroshell:capabilities'));
  assert.equal(providerClick(listeners), true, 'default navigation is prevented');
  assert.deepEqual(nativeCalls, [['MeroShell', 'providerSignIn', { url: PROVIDER_LINK }]]);
  await api.providerSignIn('/api/v1/services/9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a/inbound?provider=github');
  assert.deepEqual(nativeCalls.at(-1), ['MeroShell', 'providerSignIn', { url: PROVIDER_LINK.replace('google', 'github') }]);
});

test('a provider element without an href is left alone', async () => {
  const { win, listeners, nativeCalls } = fakeWindow({ providerSignIn: true });
  install(win, CONFIG);
  await flush();
  assert.equal(clickOn(listeners, '[data-provider-sign-in]', { href: '', getAttribute: () => null }), false);
  assert.equal(nativeCalls.length, 0);
});

test('providerSignIn refuses links off the configured https host', async () => {
  const { win, nativeCalls } = fakeWindow({ providerSignIn: true });
  const api = install(win, CONFIG);
  await flush();
  for (const url of ['https://evil.example.com/login', 'http://shop.example.com/login', 'https://shop.example.com:8443/login', 'https://u:p@shop.example.com/login']) {
    await assert.rejects(api.providerSignIn(url), /application host/, url);
  }
  assert.equal(nativeCalls.length, 0);
});

test('a document installed before the probe completes is enabled when the shell announces it', async () => {
  const { win, attrs, listeners, nativeCalls } = fakeWindow({ providerSignIn: false });
  const api = install(win, CONFIG);
  await flush();
  assert.equal(api.capabilities.providerSignIn, false);
  api._setProviderSignIn(true);
  assert.equal(attrs.get('data-meroshell-provider-sign-in'), 'on');
  assert.equal(api.capabilities.providerSignIn, true);
  assert.equal(providerClick(listeners), true);
  assert.equal(nativeCalls.length, 1);
});

test('revocation removes the binding and the attribute and makes the method reject', async () => {
  const { win, attrs, listeners, nativeCalls } = fakeWindow({ providerSignIn: true });
  const api = install(win, CONFIG);
  await flush();
  api._setProviderSignIn(false);
  assert.equal(attrs.has('data-meroshell-provider-sign-in'), false);
  assert.equal(api.capabilities.providerSignIn, false);
  assert.equal(listeners.click.length, 1);
  assert.equal(providerClick(listeners), false);
  await assert.rejects(api.providerSignIn(PROVIDER_LINK), UNAVAILABLE);
  assert.equal(nativeCalls.length, 0);
});

test('announcing the same state twice binds the click once', async () => {
  const { win, listeners } = fakeWindow({ providerSignIn: true });
  const api = install(win, CONFIG);
  await flush();
  api._setProviderSignIn(true);
  api._setProviderSignIn(true);
  assert.equal(listeners.click.length, 2);
});

test('outside the shell host nothing is bound and no capability is asked for', () => {
  for (const href of ['https://evil.example.com/', 'http://shop.example.com/']) {
    const { win, attrs, listeners, capabilityQueries } = fakeWindow({ href, providerSignIn: true });
    assert.equal(install(win, CONFIG), null);
    assert.equal(listeners.click, undefined);
    assert.equal(attrs.size, 0);
    assert.equal(capabilityQueries.length, 0);
    assert.equal(win.MeroFoundryShell, undefined);
  }
});

test('a failing capabilities query leaves provider sign-in off', async () => {
  const { win, attrs } = fakeWindow();
  win.Capacitor.nativePromise = () => Promise.reject(new Error('bridge gone'));
  const api = install(win, CONFIG);
  await flush();
  assert.equal(api.capabilities.providerSignIn, false);
  assert.equal(attrs.has('data-meroshell-provider-sign-in'), false);
});

// Bundled mode: the site is served from the platform's local origin, and the shell still
// names the application host.

const IOS_BUNDLED = { ...CONFIG, mode: 'bundled', localOrigin: 'capacitor://localhost' };
const ANDROID_BUNDLED = { ...CONFIG, platform: 'android', mode: 'bundled', localOrigin: 'https://localhost' };

test('bundled mode installs on the configured local origin of each platform and keeps the application host', () => {
  const ios = install(fakeWindow({ href: 'capacitor://localhost/orders' }).win, IOS_BUNDLED);
  assert.ok(ios);
  assert.equal(ios.mode, 'bundled');
  assert.equal(ios.host, 'shop.example.com');
  const android = install(fakeWindow({ href: 'https://localhost/' }).win, ANDROID_BUNDLED);
  assert.ok(android);
  assert.equal(android.host, 'shop.example.com');
});

test('bundled mode refuses every other origin, including the application host and the other platform\'s origin', () => {
  for (const href of ['https://shop.example.com/', 'https://localhost/', 'http://localhost/', 'capacitor://localhost.evil.com/', 'https://evil.example.com/']) {
    assert.equal(install(fakeWindow({ href }).win, IOS_BUNDLED), null, href);
  }
  for (const href of ['capacitor://localhost/', 'http://localhost/', 'https://localhost:8443/', 'https://shop.example.com/']) {
    assert.equal(install(fakeWindow({ href }).win, ANDROID_BUNDLED), null, href);
  }
  assert.equal(install(fakeWindow({ href: 'https://localhost/' }).win, { ...ANDROID_BUNDLED, localOrigin: '' }), null);
});

test('remote mode keeps its host-only rule: the local origin is refused even when one is configured', () => {
  assert.equal(install(fakeWindow({ href: 'https://localhost/' }).win, { ...CONFIG, mode: 'remote', localOrigin: 'https://localhost' }), null);
  const api = install(fakeWindow().win, { ...CONFIG, mode: 'remote' });
  assert.equal(api.mode, 'remote');
  assert.equal(install(fakeWindow().win, CONFIG).mode, 'remote', 'an omitted mode is remote');
});

// MeroFoundryShell.session: the token pair in the device's secure storage.

const PAIR = { accessToken: 'access-6f1c9e0a-secret', refreshToken: 'refresh-3b7d2f81-secret' };

for (const [mode, href, config] of [
  ['remote', 'https://shop.example.com/', CONFIG],
  ['bundled', 'capacitor://localhost/', IOS_BUNDLED],
]) {
  test(`${mode}: session.save, load and clear call the MeroShell secure-store methods`, async () => {
    const stored = { value: null };
    const answers = {
      'MeroShell.saveSession': (options) => {
        stored.value = { ...options };
        return Promise.resolve({});
      },
      'MeroShell.loadSession': () => Promise.resolve(stored.value ? { ...stored.value } : {}),
      'MeroShell.clearSession': () => {
        stored.value = null;
        return Promise.resolve({});
      },
    };
    const { win, nativeCalls } = fakeWindow({ href, answers });
    const api = install(win, config);
    assert.equal(await api.session.load(), null);
    assert.equal(await api.session.save(PAIR), undefined);
    assert.deepEqual(await api.session.load(), PAIR);
    assert.equal(await api.session.clear(), undefined);
    assert.equal(await api.session.load(), null);
    assert.deepEqual(nativeCalls.map(([plugin, method]) => `${plugin}.${method}`), [
      'MeroShell.loadSession', 'MeroShell.saveSession', 'MeroShell.loadSession', 'MeroShell.clearSession', 'MeroShell.loadSession',
    ]);
    assert.deepEqual(nativeCalls[1][2], PAIR, 'exactly the two tokens are sent');
  });
}

test('session.save sends only the two tokens and rejects anything but a pair of non-empty strings', async () => {
  const { win, nativeCalls } = fakeWindow();
  const api = install(win, CONFIG);
  await api.session.save({ ...PAIR, extra: 'x' });
  assert.deepEqual(nativeCalls.pop()[2], PAIR);
  for (const bad of [null, undefined, 'token', {}, { accessToken: PAIR.accessToken }, { ...PAIR, refreshToken: '' }, { ...PAIR, accessToken: 7 }]) {
    await assert.rejects(api.session.save(bad), (error) => {
      assert.match(error.message, /accessToken and refreshToken/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  }
  assert.equal(nativeCalls.length, 0);
});

test('session.load answers null for an incomplete stored value', async () => {
  for (const stored of [{}, { accessToken: 'a' }, { accessToken: 'a', refreshToken: '' }, null]) {
    const { win } = fakeWindow({ answers: { 'MeroShell.loadSession': () => Promise.resolve(stored) } });
    assert.equal(await install(win, CONFIG).session.load(), null);
  }
});

test('the session API is frozen and nothing about it is logged, dispatched or exposed beyond its calls', async () => {
  const logged = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level];
    console[level] = (...args) => logged.push(args.map(String).join(' '));
  }
  try {
    const { win, dispatched, attrs, props } = fakeWindow({
      answers: { 'MeroShell.loadSession': () => Promise.resolve({ ...PAIR }) },
    });
    const api = install(win, CONFIG);
    assert.ok(Object.isFrozen(api.session));
    await api.session.save(PAIR);
    await api.session.load();
    await api.session.clear();
    await flush();
    const visible = JSON.stringify({ logged, dispatched, attrs: [...attrs], props: [...props], api: Object.keys(api) });
    assert.doesNotMatch(visible, /secret/);
  } finally {
    Object.assign(console, originals);
  }
});

test('without the Capacitor bridge the session methods reject', async () => {
  const api = install(fakeWindow({ capacitor: false }).win, CONFIG);
  await assert.rejects(api.session.load(), /Capacitor bridge unavailable/);
  await assert.rejects(api.session.clear(), /Capacitor bridge unavailable/);
});

// MeroFoundryShell.bearer and meroshell:session (C.15-C.16).

test('bearer is exposed, frozen, and sends its calls through the page fetch to the application host', async () => {
  const { win, nativeCalls } = fakeWindow({
    href: 'capacitor://localhost/',
    answers: { 'MeroShell.loadSession': () => Promise.resolve({ ...PAIR }) },
  });
  const sent = [];
  win.fetch = function (input) {
    assert.equal(this, win, 'the page fetch is called on the window');
    sent.push(input);
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  const api = install(win, IOS_BUNDLED);
  assert.deepEqual(Object.keys(api.bearer).sort(), ['fetch', 'login', 'logout', 'signedIn']);
  assert.ok(Object.isFrozen(api.bearer));
  assert.equal(await api.bearer.signedIn(), true);
  await api.bearer.fetch('https://shop.example.com/api/v1/orders');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://shop.example.com/api/v1/orders');
  assert.equal(sent[0].headers.get('Authorization'), `Bearer ${PAIR.accessToken}`);
  assert.deepEqual(nativeCalls.map(([plugin, method]) => `${plugin}.${method}`), ['MeroShell.loadSession', 'MeroShell.loadSession']);
});

test('bearer.signedIn is false without a saved pair', async () => {
  const { win } = fakeWindow({ href: 'capacitor://localhost/' });
  assert.equal(await install(win, IOS_BUNDLED).bearer.signedIn(), false);
});

test('the injected bearer factory is consumed, so the page gains no extra global', () => {
  const file = require.resolve('../shell/hosted-integration.js');
  const marker = { createBearerClient: () => Object.freeze({ marker: true }) };
  delete require.cache[file];
  globalThis.__meroShellBearerClient = marker;
  try {
    const fresh = require('../shell/hosted-integration.js');
    assert.equal(globalThis.__meroShellBearerClient, undefined);
    assert.deepEqual({ ...fresh.install(fakeWindow().win, CONFIG).bearer }, { marker: true });
  } finally {
    delete globalThis.__meroShellBearerClient;
    delete require.cache[file];
    require('../shell/hosted-integration.js');
  }
});

test('_sessionChanged dispatches meroshell:session with only the signed-in flag', () => {
  const { win } = fakeWindow({ href: 'capacitor://localhost/' });
  const events = [];
  win.dispatchEvent = (event) => events.push(event);
  const api = install(win, IOS_BUNDLED);
  events.length = 0;
  api._sessionChanged({ signedIn: true, accessToken: PAIR.accessToken });
  api._sessionChanged({ signedIn: 'yes' });
  assert.deepEqual(events.map((e) => [e.type, e.detail]), [
    ['meroshell:session', { signedIn: true }],
    ['meroshell:session', { signedIn: false }],
  ]);
});

// MeroFoundryShell.push (D.13-D.15, E.21). The native side is a double of registerPush,
// unregisterPush and getPushState and the network is a fetch double: nothing here reaches APNs,
// FCM or a MeroFoundry host.

const PUSH_APP = '0f9c2a64-3b1e-4c6d-9a7e-5d2b8c1e4f30';
const PUSH_TOKEN = 'push-tok/en+ab==secret';
const DEVICES = `https://shop.example.com/api/v1/public/applications/${PUSH_APP}/push/devices`;
const { PUSH_RENEW_MS } = require('../shell/hosted-integration.js');

/** A native push double that remembers enabled and the token like the platform stores do. */
function pushDevice({ enabled = false, register = 'granted', applicationId = PUSH_APP, platform = 'apns' } = {}) {
  const device = { enabled, token: enabled ? PUSH_TOKEN : null, applicationId, held: null };
  const answers = {
    'MeroShell.getPushState': () =>
      Promise.resolve({ enabled: device.enabled, permission: 'granted', platform, appVersion: '1.4.0 (12)', applicationId: device.applicationId }),
    'MeroShell.registerPush': () => {
      const answer = () => {
        if (register === 'granted') {
          device.enabled = true;
          device.token = PUSH_TOKEN;
          return { status: 'granted', token: PUSH_TOKEN, platform };
        }
        return register === 'denied' ? { status: 'denied' } : { status: 'unavailable', reason: 'not_configured' };
      };
      if (device.hold) {
        return new Promise((resolve) => {
          device.held = () => resolve(answer());
        });
      }
      return Promise.resolve(answer());
    },
    'MeroShell.unregisterPush': () => {
      const previous = device.token;
      device.enabled = false;
      device.token = null;
      return Promise.resolve({ status: 'unregistered', token: previous });
    },
    'MeroShell.pushDisabled': () => Promise.resolve({}),
  };
  return { device, answers };
}

/** A fetch double that records each request and answers `respond(request)`. */
function network(respond = () => new Response('{}', { status: 200 })) {
  const requests = [];
  const pending = [];
  async function fetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    const entry = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      credentials: input instanceof Request ? request.credentials : init && init.credentials,
      body: request.method === 'PUT' ? JSON.parse(await request.clone().text()) : null,
    };
    requests.push(entry);
    return respond(entry);
  }
  /** Make each next request wait until release() is called. */
  function holdAll() {
    respond = () => new Promise((resolve) => pending.push(() => resolve(new Response('{}', { status: 200 }))));
  }
  function release() {
    pending.shift()();
    return flush();
  }
  return { requests, fetch, holdAll, release };
}

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const PUSH_MODES = [
  ['remote', 'https://shop.example.com/', CONFIG, {}],
  ['bundled', 'capacitor://localhost/', IOS_BUNDLED, { 'MeroShell.loadSession': () => Promise.resolve({ ...PAIR }) }],
];

/** Install the page with a push device, a network and launch storage; returns everything. */
async function pushPage({ href, config, extra = {}, device = pushDevice(), net = network(), storage = memoryStorage(), language = 'fr-CA' }) {
  const fake = fakeWindow({ href, answers: { ...extra, ...device.answers } });
  fake.win.fetch = net.fetch;
  fake.win.sessionStorage = storage;
  fake.win.navigator.language = language;
  const api = install(fake.win, config);
  await flush();
  await flush();
  return { ...fake, api, device: device.device, net, storage };
}

for (const [mode, href, config, extra] of PUSH_MODES) {
  test(`${mode}: enable() registers the device with the application id, native app version and navigator.language`, async () => {
    const page = await pushPage({ href, config, extra });
    assert.deepEqual(await page.api.push.enable(), { status: 'enabled' });
    assert.equal(page.net.requests.length, 1);
    const [put] = page.net.requests;
    assert.equal(put.method, 'PUT');
    assert.equal(put.url, DEVICES);
    assert.deepEqual(put.body, { data: { token: PUSH_TOKEN, platform: 'apns', app_version: '1.4.0 (12)', locale: 'fr-CA' } });
    assert.equal(put.headers.get('X-Requested-With'), 'XMLHttpRequest');
    assert.equal(put.headers.get('Content-Type'), 'application/json');
    if (mode === 'remote') {
      assert.equal(put.credentials, 'include', 'the page cookies carry the session');
      assert.equal(put.headers.get('Authorization'), null);
    } else {
      assert.equal(put.headers.get('Authorization'), `Bearer ${PAIR.accessToken}`, 'through MeroFoundryShell.bearer.fetch');
      assert.equal(put.credentials, 'omit');
    }
    assert.deepEqual(page.pushCalls.map(([method]) => method).filter((m) => m !== 'getPushState'), ['registerPush']);
  });

  test(`${mode}: a denied permission is reported and nothing is sent`, async () => {
    const page = await pushPage({ href, config, extra, device: pushDevice({ register: 'denied' }) });
    assert.deepEqual(await page.api.push.enable(), { status: 'denied' });
    assert.equal(page.net.requests.length, 0);
  });

  test(`${mode}: an unconfigured platform (no google-services.json) is reported unavailable and nothing is sent`, async () => {
    const page = await pushPage({ href, config, extra, device: pushDevice({ register: 'unavailable', platform: 'fcm' }) });
    assert.deepEqual(await page.api.push.enable(), { status: 'unavailable', reason: 'not_configured' });
    assert.equal(page.net.requests.length, 0);
  });

  test(`${mode}: a failed registration request is reported with its status, and a network error with 0`, async () => {
    const failing = network(() => new Response('{"detail":"nope"}', { status: 500 }));
    const page = await pushPage({ href, config, extra, net: failing });
    assert.deepEqual(await page.api.push.enable(), { status: 'failed', reason: 'request', httpStatus: 500 });
    const offline = network(() => Promise.reject(new TypeError('Failed to fetch')));
    const other = await pushPage({ href, config, extra, net: offline });
    assert.deepEqual(await other.api.push.enable(), { status: 'failed', reason: 'request', httpStatus: 0 });
  });

  test(`${mode}: without the application id the registration waits and resumes when the shell provides it`, async () => {
    const page = await pushPage({ href, config, extra, device: pushDevice({ applicationId: null }) });
    assert.deepEqual(await page.api.push.enable(), { status: 'pending', reason: 'application' });
    assert.equal(page.net.requests.length, 0);
    page.api._setApplicationId('not-a-uuid');
    await flush();
    assert.equal(page.net.requests.length, 0);
    page.api._setApplicationId(PUSH_APP.toUpperCase());
    await flush();
    await flush();
    await flush();
    assert.deepEqual(page.net.requests.map((r) => [r.method, r.url]), [['PUT', DEVICES]]);
  });

  test(`${mode}: disable() deletes the native token, then DELETEs that registration with the token encoded`, async () => {
    const page = await pushPage({ href, config, extra, device: pushDevice({ enabled: true }), storage: memoryStorage({ 'meroshell.push.renewedAt': String(Date.now()) }) });
    assert.deepEqual(await page.api.push.disable(), { status: 'disabled' });
    assert.equal(page.device.enabled, false);
    assert.deepEqual(page.net.requests.map((r) => [r.method, r.url]), [['DELETE', `${DEVICES}/${encodeURIComponent(PUSH_TOKEN)}`]]);
    assert.match(page.net.requests[0].url, /push-tok%2Fen%2Bab%3D%3Dsecret$/);
    assert.equal(page.net.requests[0].headers.get('X-Requested-With'), 'XMLHttpRequest');
    if (mode === 'bundled') {
      assert.equal(page.net.requests[0].headers.get('Authorization'), `Bearer ${PAIR.accessToken}`);
    } else {
      assert.equal(page.net.requests[0].credentials, 'include');
    }
    const order = page.pushCalls.map(([method]) => method);
    assert.ok(order.indexOf('unregisterPush') >= 0);
    assert.equal(page.storage.map.has('meroshell.push.renewedAt'), false);
    assert.deepEqual(await page.api.push.disable(), { status: 'disabled' }, 'nothing left to delete');
    assert.equal(page.net.requests.length, 1);
  });

  test(`${mode}: disable() treats 404 as removed and reports other failures`, async () => {
    const gone = await pushPage({ href, config, extra, device: pushDevice({ enabled: true }), net: network(() => new Response('', { status: 404 })), storage: memoryStorage({ 'meroshell.push.renewedAt': String(Date.now()) }) });
    assert.deepEqual(await gone.api.push.disable(), { status: 'disabled' });
    const broken = await pushPage({ href, config, extra, device: pushDevice({ enabled: true }), net: network(() => new Response('', { status: 503 })), storage: memoryStorage({ 'meroshell.push.renewedAt': String(Date.now()) }) });
    assert.deepEqual(await broken.api.push.disable(), { status: 'failed', reason: 'request', httpStatus: 503 });
    assert.equal(broken.device.enabled, false, 'native push is off even when the server call failed');
  });

  test(`${mode}: ready-time renewal happens once per launch and only while enabled`, async () => {
    const off = await pushPage({ href, config, extra });
    assert.equal(off.pushCalls.filter(([m]) => m === 'registerPush').length, 0, 'never prompts or registers while off');
    assert.equal(off.net.requests.length, 0);
    const storage = memoryStorage();
    const first = await pushPage({ href, config, extra, device: pushDevice({ enabled: true }), storage });
    await flush();
    assert.deepEqual(first.net.requests.map((r) => r.method), ['PUT']);
    const second = await pushPage({ href, config, extra, device: pushDevice({ enabled: true }), storage });
    await flush();
    assert.equal(second.net.requests.length, 0, 'the next page of the same launch does not renew');
  });

  test(`${mode}: a resume a day after the last renewal renews; an earlier one does not`, async () => {
    const storage = memoryStorage({ 'meroshell.push.renewedAt': String(Date.now() - 1000) });
    const page = await pushPage({ href, config, extra, device: pushDevice({ enabled: true }), storage });
    page.win.document.visibilityState = 'visible';
    for (const fn of page.listeners.visibilitychange) {
      fn();
    }
    await flush();
    await flush();
    assert.equal(page.net.requests.length, 0);
    storage.setItem('meroshell.push.renewedAt', String(Date.now() - PUSH_RENEW_MS));
    for (const fn of page.listeners.visibilitychange) {
      fn();
    }
    for (let i = 0; i < 6; i += 1) {
      await flush();
    }
    assert.deepEqual(page.net.requests.map((r) => r.method), ['PUT']);
  });

  test(`${mode}: a native token refresh registers through the same path, and is ignored once disabled`, async () => {
    const page = await pushPage({ href, config, extra, device: pushDevice({ enabled: true }), storage: memoryStorage({ 'meroshell.push.renewedAt': String(Date.now()) }) });
    page.api._pushToken({ token: 'refreshed-token', platform: 'apns' });
    for (let i = 0; i < 4; i += 1) {
      await flush();
    }
    assert.deepEqual(page.net.requests.map((r) => [r.method, r.body && r.body.data.token]), [['PUT', 'refreshed-token']]);
    await page.api.push.disable();
    page.api._pushToken({ token: 'late-token', platform: 'apns' });
    for (let i = 0; i < 4; i += 1) {
      await flush();
    }
    assert.deepEqual(page.net.requests.map((r) => r.method), ['PUT', 'DELETE']);
  });

  test(`${mode}: a registration in flight when disable() is called is compensated by the DELETE, never left behind`, async () => {
    const net = network();
    const page = await pushPage({ href, config, extra, net });
    net.holdAll();
    const enabling = page.api.push.enable();
    for (let i = 0; i < 4; i += 1) {
      await flush();
    }
    assert.deepEqual(net.requests.map((r) => r.method), ['PUT']);
    const disabling = page.api.push.disable();
    page.api._pushToken({ token: PUSH_TOKEN, platform: 'apns' });
    await net.release();
    assert.deepEqual(await enabling, { status: 'enabled' });
    for (let i = 0; i < 4; i += 1) {
      await flush();
    }
    await net.release();
    assert.deepEqual(await disabling, { status: 'disabled' });
    for (let i = 0; i < 4; i += 1) {
      await flush();
    }
    assert.deepEqual(net.requests.map((r) => r.method), ['PUT', 'DELETE'], 'the refresh queued after disable never registers');
    assert.equal(page.device.enabled, false);
  });

  test(`${mode}: an enable() or renewal still waiting for native code when disable() is called never registers`, async () => {
    const device = pushDevice({ enabled: true });
    device.device.hold = true;
    const net = network();
    const page = await pushPage({ href, config, extra, device, net });
    assert.equal(typeof page.device.held, 'function', 'the ready-time renewal is waiting for registerPush');
    const enabling = page.api.push.enable();
    const disabling = page.api.push.disable();
    page.device.held();
    for (let i = 0; i < 6; i += 1) {
      await flush();
    }
    assert.deepEqual(await enabling, { status: 'cancelled' });
    assert.deepEqual(await disabling, { status: 'disabled' });
    assert.deepEqual(net.requests.map((r) => r.method), ['DELETE'], 'only the cleanup reaches the server');
  });

  test(`${mode}: _pushDisable reports the outcome to native code with no token`, async () => {
    const page = await pushPage({ href, config, extra, device: pushDevice({ enabled: true }), storage: memoryStorage({ 'meroshell.push.renewedAt': String(Date.now()) }) });
    await page.api._pushDisable();
    assert.deepEqual(page.pushCalls.filter(([m]) => m === 'pushDisabled'), [['pushDisabled', { ok: true }]]);
    const failing = await pushPage({ href, config, extra, device: pushDevice({ enabled: true }), net: network(() => new Response('', { status: 500 })), storage: memoryStorage({ 'meroshell.push.renewedAt': String(Date.now()) }) });
    await failing.api._pushDisable();
    assert.deepEqual(failing.pushCalls.filter(([m]) => m === 'pushDisabled'), [['pushDisabled', { ok: false }]]);
  });
}

test('bundled: without a saved pair the registration waits, and a sign-in that saves one resumes it', async () => {
  const stored = { value: null };
  const extra = {
    'MeroShell.loadSession': () => Promise.resolve(stored.value ? { ...stored.value } : {}),
    'MeroShell.saveSession': (options) => {
      stored.value = { ...options };
      return Promise.resolve({});
    },
  };
  const page = await pushPage({ href: 'capacitor://localhost/', config: IOS_BUNDLED, extra });
  assert.deepEqual(await page.api.push.enable(), { status: 'pending', reason: 'session' });
  assert.equal(page.net.requests.length, 0);
  await page.api.session.save(PAIR);
  for (let i = 0; i < 8; i += 1) {
    await flush();
  }
  assert.deepEqual(page.net.requests.map((r) => [r.method, r.headers.get('Authorization')]), [['PUT', `Bearer ${PAIR.accessToken}`]]);
});

test('bundled: a provider sign-in completed by the shell resumes a waiting registration', async () => {
  const stored = { value: null };
  const page = await pushPage({
    href: 'capacitor://localhost/',
    config: IOS_BUNDLED,
    extra: { 'MeroShell.loadSession': () => Promise.resolve(stored.value ? { ...stored.value } : {}) },
  });
  assert.deepEqual(await page.api.push.enable(), { status: 'pending', reason: 'session' });
  stored.value = { ...PAIR };
  page.api._sessionChanged({ signedIn: true });
  for (let i = 0; i < 8; i += 1) {
    await flush();
  }
  assert.deepEqual(page.net.requests.map((r) => r.method), ['PUT']);
});

test('bundled: disable() without a saved pair turns push off natively and reports the missing session', async () => {
  const page = await pushPage({ href: 'capacitor://localhost/', config: IOS_BUNDLED, device: pushDevice({ enabled: true }), storage: memoryStorage({ 'meroshell.push.renewedAt': String(Date.now()) }) });
  assert.deepEqual(await page.api.push.disable(), { status: 'failed', reason: 'session', httpStatus: 0 });
  assert.equal(page.device.enabled, false);
  assert.equal(page.net.requests.length, 0);
});

test('remote: a 401 leaves the registration waiting for a session, and the next signed-in page registers', async () => {
  const storage = memoryStorage();
  const signedOut = await pushPage({ href: 'https://shop.example.com/', config: CONFIG, net: network(() => new Response('', { status: 401 })), storage });
  assert.deepEqual(await signedOut.api.push.enable(), { status: 'pending', reason: 'session' });
  assert.equal(storage.map.has('meroshell.push.renewedAt'), false, 'an unregistered device stays due');
  const signedIn = await pushPage({ href: 'https://shop.example.com/account', config: CONFIG, device: pushDevice({ enabled: true }), storage });
  await flush();
  assert.deepEqual(signedIn.net.requests.map((r) => [r.method, r.url]), [['PUT', DEVICES]]);
});

test('state() answers enabled, permission and platform and never a token', async () => {
  const page = await pushPage({ href: 'https://shop.example.com/', config: CONFIG, device: pushDevice({ enabled: true, platform: 'fcm' }), storage: memoryStorage({ 'meroshell.push.renewedAt': String(Date.now()) }) });
  assert.deepEqual(await page.api.push.state(), { enabled: true, permission: 'granted', platform: 'fcm' });
  const bare = install(fakeWindow({ capacitor: false }).win, CONFIG);
  assert.deepEqual(await bare.push.state(), { enabled: false, permission: 'unavailable', platform: '' });
  assert.deepEqual(await bare.push.enable(), { status: 'unavailable', reason: 'bridge' });
});

test('push is frozen and no push token is logged, dispatched or exposed', async () => {
  const logged = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level];
    console[level] = (...args) => logged.push(args.map(String).join(' '));
  }
  try {
    const events = [];
    const page = await pushPage({ href: 'https://shop.example.com/', config: CONFIG });
    page.win.dispatchEvent = (event) => events.push(event);
    assert.ok(Object.isFrozen(page.api.push));
    assert.deepEqual(Object.keys(page.api.push).sort(), ['disable', 'enable', 'state']);
    await page.api.push.enable();
    page.api._pushToken({ token: 'refresh-secret', platform: 'apns' });
    await flush();
    await page.api.push.state();
    await page.api.push.disable();
    const visible = JSON.stringify({ logged, events: events.map((e) => [e.type, e.detail]), attrs: [...page.attrs], api: Object.keys(page.api), storage: [...page.storage.map] });
    assert.doesNotMatch(visible, /secret/);
  } finally {
    Object.assign(console, originals);
  }
});

test('_pushEvent dispatches meroshell:push only for a known rejection, with only type and reason', () => {
  const { win } = fakeWindow();
  const events = [];
  win.dispatchEvent = (event) => events.push(event);
  const api = install(win, CONFIG);
  events.length = 0;
  api._pushEvent({ type: 'rejected', reason: 'too_long', path: '/secret' });
  api._pushEvent({ type: 'rejected', reason: 'made_up' });
  api._pushEvent({ type: 'opened', reason: 'too_long' });
  api._pushEvent(null);
  assert.deepEqual(events.map((e) => [e.type, e.detail]), [['meroshell:push', { type: 'rejected', reason: 'too_long' }]]);
});
