'use strict';

/*
 * Provider sign-in from the shell (ADR 2026-10-16 v2, Ruling 6) as the controller drives it:
 * the capability probe, the pending leg, the intercepted provider redirect, the system
 * web-authentication session and the exchange return. FakeNative stands in for both native
 * bootstraps; nothing here establishes that ASWebAuthenticationSession or Custom Tabs behave as
 * modelled on a device, or that a provider round trip succeeds end to end.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createController, WEB_AUTH_CLOSE_GRACE_MS } = require('../shell/controller.js');
const { FakeNative, FakeView, flush } = require('./helpers/doubles.cjs');

const HOST = 'shop.example.com';
const APP = '0f9c2a64-3b1e-4c6d-9a7e-5d2b8c1e4f30';
const EXCHANGE = `/api/v1/applications/${APP}/auth/oauth/exchange`;
const PROVIDER = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=c&state=s';
const SIGN_IN = `https://${HOST}/api/v1/services/9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a/inbound?provider=google`;

/** Answers for the two probe requests; a test overrides one to model a failure. */
function catalogAnswers({ metadata, catalog } = {}) {
  return {
    '/api/v1/applications/public/by-host': metadata || { status: 200, body: JSON.stringify({ id: APP, slug: 'shop' }) },
    '/.well-known/api-catalog': catalog || { status: 200, body: JSON.stringify({ linkset: [], mobile_shell: { provider_sign_in: true } }) },
  };
}

/** Timer double: the grace period after a Custom Tab closes runs only when a test says so. */
class FakeTimers {
  constructor() {
    this.queue = [];
  }

  schedule(fn, ms) {
    this.queue.push({ fn, ms });
  }

  async runAll() {
    const due = this.queue.splice(0);
    due.forEach((t) => t.fn());
    await flush();
    return due.map((t) => t.ms);
  }
}

async function setup({ launch = {}, answers = catalogAnswers(), loaded = true } = {}) {
  const native = new FakeNative({ providerSignInSupported: true, ...launch });
  native.answer('fetchHost', (args) => {
    const answer = answers[args.path];
    if (answer instanceof Error) {
      throw answer;
    }
    return answer || { status: 404, body: '' };
  });
  const view = new FakeView();
  const timers = new FakeTimers();
  const logged = [];
  const controller = createController({
    native,
    view,
    log: (...args) => logged.push(args.join(' ')),
    schedule: (fn, ms) => timers.schedule(fn, ms),
  });
  await controller.start();
  await flush();
  if (loaded) {
    controller.handleEvent('pageLoaded', { url: `https://${HOST}/login` });
    await flush();
  }
  return { native, view, timers, logged, controller };
}

const lastArgs = (native, cmd) => native.calls.filter((c) => c.cmd === cmd).at(-1).args;
const loads = (native) => native.calls.filter((c) => c.cmd === 'loadHost').map((c) => c.args.path);

async function request(s, url = SIGN_IN) {
  s.controller.handleEvent('providerSignInRequested', { url });
  await flush();
}

async function redirected(s) {
  await request(s);
  const leg = lastArgs(s.native, 'startProviderSignIn').leg;
  s.controller.handleEvent('providerRedirect', { url: PROVIDER, leg });
  await flush();
  return leg;
}

// Capability probe

test('the probe reads the by-host metadata, then the catalog, and enables provider sign-in', async () => {
  const { native } = await setup();
  assert.deepEqual(
    native.calls.filter((c) => c.cmd === 'fetchHost').map((c) => c.args.path),
    ['/api/v1/applications/public/by-host', '/.well-known/api-catalog'],
  );
  assert.deepEqual(lastArgs(native, 'setHostCapabilities'), { providerSignIn: true });
});

test('without native support nothing is fetched and the capability stays off', async () => {
  const { native } = await setup({ launch: { providerSignInSupported: false } });
  assert.equal(native.count('fetchHost'), 0);
  assert.equal(native.count('setHostCapabilities'), 0);
});

test('without native support a request starts nothing even if the catalog would allow it', async () => {
  const s = await setup({ launch: { providerSignInSupported: false } });
  await request(s);
  assert.equal(s.native.count('startProviderSignIn'), 0);
});

test('a missing or false catalog field, a non-200 answer or a network failure disables support', async () => {
  for (const catalog of [
    { status: 200, body: JSON.stringify({ linkset: [] }) },
    { status: 200, body: JSON.stringify({ mobile_shell: { provider_sign_in: false } }) },
    { status: 404, body: '' },
    { status: 503, body: JSON.stringify({ mobile_shell: { provider_sign_in: true } }) },
    new Error('offline'),
  ]) {
    const s = await setup({ answers: catalogAnswers({ catalog }) });
    assert.equal(s.native.count('setHostCapabilities'), 0, JSON.stringify(String(catalog.body || catalog)));
    await request(s);
    assert.equal(s.native.count('startProviderSignIn'), 0);
  }
});

test('an application id that cannot be validated disables support without asking the catalog', async () => {
  for (const metadata of [{ status: 200, body: JSON.stringify({ slug: 'shop' }) }, { status: 404, body: '' }, new Error('offline')]) {
    const s = await setup({ answers: catalogAnswers({ metadata }) });
    assert.deepEqual(s.native.calls.filter((c) => c.cmd === 'fetchHost').map((c) => c.args.path), ['/api/v1/applications/public/by-host']);
    assert.equal(s.native.count('setHostCapabilities'), 0);
  }
});

test('the catalog is fetched once per launch; page loads only re-send the known capability', async () => {
  const { native, controller } = await setup();
  for (const path of ['/a', '/b', '/c']) {
    controller.handleEvent('pageLoaded', { url: `https://${HOST}${path}` });
  }
  await flush();
  assert.equal(native.count('fetchHost'), 2);
  const sent = native.calls.filter((c) => c.cmd === 'setHostCapabilities').map((c) => c.args.providerSignIn);
  assert.ok(sent.length >= 4, 'every newly loaded document is told the capability');
  assert.ok(sent.every((v) => v === true));
});

test('a document loaded before the probe completes is told once the probe answers', async () => {
  const native = new FakeNative({ providerSignInSupported: true });
  native.hold('fetchHost');
  const controller = createController({ native, view: new FakeView() });
  await controller.start();
  controller.handleEvent('pageLoaded', { url: `https://${HOST}/` });
  await flush();
  assert.equal(native.count('setHostCapabilities'), 0, 'nothing is announced before the probe answers');
  const answers = catalogAnswers();
  await native.release('fetchHost', answers['/api/v1/applications/public/by-host']);
  await native.release('fetchHost', answers['/.well-known/api-catalog']);
  assert.deepEqual(lastArgs(native, 'setHostCapabilities'), { providerSignIn: true });
});

test('sign-out turns the capability off, re-fetches the catalog and applies a revocation', async () => {
  const answers = catalogAnswers();
  const { native, controller } = await setup({ answers });
  answers['/.well-known/api-catalog'] = { status: 200, body: JSON.stringify({ mobile_shell: { provider_sign_in: false } }) };
  await controller.act('openSettings');
  await controller.act('signOut');
  await flush();
  assert.equal(native.count('fetchHost'), 4, 'by-host and catalog again after sign-out');
  const cmds = native.commands();
  assert.ok(cmds.lastIndexOf('clearCookies') < cmds.lastIndexOf('fetchHost'));
  assert.deepEqual(lastArgs(native, 'setHostCapabilities'), { providerSignIn: false });
  controller.handleEvent('pageLoaded', { url: `https://${HOST}/` });
  await flush();
  assert.deepEqual(lastArgs(native, 'setHostCapabilities'), { providerSignIn: false });
  await request({ native, controller });
  assert.equal(native.count('startProviderSignIn'), 0, 'a revoked capability refuses new legs');
});

test('sign-out re-enables the capability when the catalog still offers it', async () => {
  const { native, controller } = await setup();
  await controller.act('openSettings');
  await controller.act('signOut');
  await flush();
  const sent = native.calls.filter((c) => c.cmd === 'setHostCapabilities').map((c) => c.args.providerSignIn);
  assert.deepEqual(sent.slice(-2), [false, true]);
});

// Starting a leg

test('a request on the shown page starts authorization in the hosted WebView with the sign-in path', async () => {
  const s = await setup();
  await request(s);
  const args = lastArgs(s.native, 'startProviderSignIn');
  assert.equal(args.path, new URL(SIGN_IN).pathname + new URL(SIGN_IN).search);
  assert.equal(typeof args.leg, 'number');
  assert.equal(s.native.count('openWebAuth'), 0, 'nothing opens before the provider redirect');
});

test('a sign-in link on another host or scheme starts nothing', async () => {
  const s = await setup();
  for (const url of ['https://evil.example.com/login', 'http://shop.example.com/login', 'https://accounts.google.com/o/oauth2']) {
    await request(s, url);
  }
  assert.equal(s.native.count('startProviderSignIn'), 0);
});

test('requests are refused while locked, unlocking, authenticating or in settings', async () => {
  // Locked and authenticating: the prompt is held open.
  const locked = await setup({ launch: { lockEnabled: true } });
  locked.native.hold('authenticate');
  locked.controller.handleEvent('resume', { backgrounded: true });
  await flush();
  await request(locked);
  assert.equal(locked.native.count('startProviderSignIn'), 0, 'locked and authenticating');

  // Settings shown over the page.
  const settings = await setup();
  await settings.controller.act('openSettings');
  await request(settings);
  assert.equal(settings.native.count('startProviderSignIn'), 0, 'settings');

  // Not yet loaded (boot screen) and offline.
  const boot = await setup({ loaded: false });
  await request(boot);
  boot.controller.handleEvent('pageFailed', { url: `https://${HOST}/` });
  await flush();
  await request(boot);
  assert.equal(boot.native.count('startProviderSignIn'), 0, 'boot and offline');
});

test('a second request while a leg is pending is refused', async () => {
  const s = await setup();
  await request(s);
  await request(s);
  assert.equal(s.native.count('startProviderSignIn'), 1);
});

// Redirect and web-authentication session

test('the pending redirect opens the system session with the configured callback host and exact exchange path', async () => {
  const s = await setup();
  const leg = await redirected(s);
  assert.deepEqual(lastArgs(s.native, 'openWebAuth'), { url: PROVIDER, callbackHost: HOST, callbackPath: EXCHANGE, leg });
  assert.equal(loads(s.native).length, 0, 'the provider URL is never loaded in the WebView');
});

test('a redirect for a stale or unknown leg, or to a non-https URL, opens nothing', async () => {
  const s = await setup();
  await request(s);
  const leg = lastArgs(s.native, 'startProviderSignIn').leg;
  s.controller.handleEvent('providerRedirect', { url: PROVIDER, leg: leg + 1 });
  s.controller.handleEvent('providerRedirect', { url: 'http://accounts.google.com/', leg });
  await flush();
  assert.equal(s.native.count('openWebAuth'), 0);
});

test('a redirect without a pending leg opens nothing', async () => {
  const s = await setup();
  s.controller.handleEvent('providerRedirect', { url: PROVIDER, leg: 1 });
  await flush();
  assert.equal(s.native.count('openWebAuth'), 0);
});

// Return

test('a valid exchange return loads its path and query, and the next page load ends the leg', async () => {
  const s = await setup();
  const leg = await redirected(s);
  s.controller.handleEvent('webAuthReturned', { url: `https://${HOST}${EXCHANGE}?code=one-time`, leg });
  await flush();
  assert.deepEqual(loads(s.native), [`${EXCHANGE}?code=one-time`]);
  s.controller.handleEvent('pageLoaded', { url: `https://${HOST}/account` });
  await flush();
  assert.equal(s.native.commands().at(-1), 'setHostCapabilities');
  s.controller.handleEvent('webAuthReturned', { url: `https://${HOST}${EXCHANGE}?code=again`, leg });
  await flush();
  assert.equal(loads(s.native).length, 1, 'a finished leg cannot be replayed');
  await request(s);
  assert.equal(s.native.count('startProviderSignIn'), 2, 'a new leg may start after success');
});

test('invalid returns are logged and clear the leg without navigating', async () => {
  for (const url of [
    `https://evil.example.com${EXCHANGE}?code=a`,
    `https://user:pw@${HOST}${EXCHANGE}?code=a`,
    `https://${HOST}:444${EXCHANGE}?code=a`,
    `https://${HOST}/api/v1/applications/1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d/auth/oauth/exchange?code=a`,
    `https://${HOST}/orders`,
    `http://${HOST}${EXCHANGE}?code=a`,
  ]) {
    const s = await setup();
    const leg = await redirected(s);
    s.controller.handleEvent('webAuthReturned', { url, leg });
    await flush();
    assert.equal(loads(s.native).length, 0, url);
    assert.ok(s.logged.some((line) => /invalid/i.test(line)), url);
    s.controller.handleEvent('webAuthReturned', { url: `https://${HOST}${EXCHANGE}?code=a`, leg });
    await flush();
    assert.equal(loads(s.native).length, 0, 'the cleared leg accepts nothing afterwards');
  }
});

test('an intermediate callback-service link is not treated as the exchange return', async () => {
  const s = await setup();
  const leg = await redirected(s);
  s.controller.handleEvent('webAuthReturned', { url: SIGN_IN.replace('?provider=google', '?code=p&state=s'), leg });
  await flush();
  assert.equal(loads(s.native).length, 0);
  s.controller.handleEvent('webAuthReturned', { url: `https://${HOST}${EXCHANGE}?code=ok`, leg });
  await flush();
  assert.deepEqual(loads(s.native), [`${EXCHANGE}?code=ok`], 'the leg stayed pending for the real return');
});

test('a deep link to an exchange or, during a leg, a callback-service path never navigates', async () => {
  const s = await setup();
  s.controller.handleEvent('deepLink', { url: `https://${HOST}${EXCHANGE}?code=replayed` });
  await flush();
  await redirected(s);
  s.controller.handleEvent('deepLink', { url: SIGN_IN });
  await flush();
  assert.equal(loads(s.native).length, 0);
  s.controller.handleEvent('deepLink', { url: `https://${HOST}/orders/7` });
  await flush();
  assert.deepEqual(loads(s.native), ['/orders/7'], 'ordinary deep links keep v1 behaviour');
});

// Cleanup

test('a page load before the redirect ends the leg and tells native to stop intercepting', async () => {
  const s = await setup();
  await request(s);
  s.controller.handleEvent('pageLoaded', { url: `https://${HOST}/oauth-error` });
  await flush();
  assert.ok(s.native.count('cancelProviderSignIn') >= 1);
  const leg = lastArgs(s.native, 'startProviderSignIn').leg;
  s.controller.handleEvent('providerRedirect', { url: PROVIDER, leg });
  await flush();
  assert.equal(s.native.count('openWebAuth'), 0);
});

test('a failed exchange load shows the offline screen and ends the leg', async () => {
  const s = await setup();
  const leg = await redirected(s);
  s.controller.handleEvent('webAuthReturned', { url: `https://${HOST}${EXCHANGE}?code=a`, leg });
  s.controller.handleEvent('pageFailed', { url: `https://${HOST}${EXCHANGE}?code=a` });
  await flush();
  assert.equal(s.view.current.name, 'offline');
  await s.controller.act('retry');
  assert.equal(loads(s.native).at(-1), '/login', 'retry reloads the origin page, never the one-time exchange');
});

test('a failure while the leg is starting shows the offline screen and later returns cannot navigate', async () => {
  const s = await setup();
  await request(s);
  const leg = lastArgs(s.native, 'startProviderSignIn').leg;
  s.controller.handleEvent('pageFailed', { url: `https://${HOST}/sign-in` });
  await flush();
  assert.equal(s.view.current.name, 'offline');
  s.controller.handleEvent('providerRedirect', { url: PROVIDER, leg });
  s.controller.handleEvent('webAuthReturned', { url: `https://${HOST}${EXCHANGE}?code=a`, leg });
  await flush();
  assert.equal(s.native.count('openWebAuth'), 0);
  assert.equal(loads(s.native).length, 0);
});

test('a cancelled session ends the leg silently and a late return cannot navigate', async () => {
  const s = await setup();
  const leg = await redirected(s);
  const shown = s.view.shown.length;
  s.controller.handleEvent('webAuthCancelled', { leg });
  await flush();
  assert.equal(s.view.current.name, 'privacy', 'the page stays shown with no error');
  assert.ok(s.view.shown.length - shown <= 1);
  s.controller.handleEvent('webAuthReturned', { url: `https://${HOST}${EXCHANGE}?code=late`, leg });
  await flush();
  assert.equal(loads(s.native).length, 0);
});

test('other session errors go to the offline screen, whose retry reloads the page sign-in began on', async () => {
  const s = await setup();
  const leg = await redirected(s);
  s.controller.handleEvent('webAuthFailed', { leg, message: 'presentation failed' });
  await flush();
  assert.equal(s.view.current.name, 'offline');
  await s.controller.act('retry');
  assert.equal(loads(s.native).at(-1), '/login');
});

test('a session that cannot be opened is reported through the same error screen', async () => {
  const s = await setup();
  s.native.answer('openWebAuth', () => {
    throw new Error('no Custom Tabs provider');
  });
  await redirected(s);
  assert.equal(s.view.current.name, 'offline');
});

test('a resume that locks the shell invalidates the leg; a later return cannot navigate', async () => {
  const s = await setup({ launch: { lockEnabled: true } });
  const leg = await redirected(s);
  s.controller.handleEvent('resume', { backgrounded: true });
  await flush();
  assert.ok(s.native.count('cancelProviderSignIn') >= 1);
  s.controller.handleEvent('webAuthReturned', { url: `https://${HOST}${EXCHANGE}?code=late`, leg });
  await flush();
  assert.equal(loads(s.native).length, 0);
});

test('an ordinary resume does not cancel a leg', async () => {
  const s = await setup({ launch: { lockEnabled: true } });
  const leg = await redirected(s);
  s.controller.handleEvent('resume', { backgrounded: false });
  await flush();
  s.controller.handleEvent('webAuthReturned', { url: `https://${HOST}${EXCHANGE}?code=ok`, leg });
  await flush();
  assert.deepEqual(loads(s.native), [`${EXCHANGE}?code=ok`]);
});

test('a Custom Tab close racing ahead of a valid return does not cancel the success', async () => {
  const s = await setup();
  const leg = await redirected(s);
  s.controller.handleEvent('webAuthClosed', { leg });
  await flush();
  s.controller.handleEvent('webAuthReturned', { url: `https://${HOST}${EXCHANGE}?code=ok`, leg });
  await flush();
  assert.deepEqual(await s.timers.runAll(), [WEB_AUTH_CLOSE_GRACE_MS]);
  assert.deepEqual(loads(s.native), [`${EXCHANGE}?code=ok`]);
  s.controller.handleEvent('pageLoaded', { url: `https://${HOST}/account` });
  await flush();
  assert.notEqual(s.view.current.name, 'offline');
});

test('a Custom Tab closed without a return cancels silently after the grace period', async () => {
  const s = await setup();
  const leg = await redirected(s);
  s.controller.handleEvent('webAuthClosed', { leg });
  await flush();
  await s.timers.runAll();
  assert.equal(s.view.current.name, 'privacy');
  s.controller.handleEvent('webAuthReturned', { url: `https://${HOST}${EXCHANGE}?code=late`, leg });
  await flush();
  assert.equal(loads(s.native).length, 0, 'a return after the grace period cannot navigate');
  await request(s);
  assert.equal(s.native.count('startProviderSignIn'), 2);
});

test('a return closing ahead of the tab, then the tab close, keeps the success', async () => {
  const s = await setup();
  const leg = await redirected(s);
  s.controller.handleEvent('webAuthReturned', { url: `https://${HOST}${EXCHANGE}?code=ok`, leg });
  s.controller.handleEvent('webAuthClosed', { leg });
  await flush();
  await s.timers.runAll();
  assert.deepEqual(loads(s.native), [`${EXCHANGE}?code=ok`]);
});

test('sign-out invalidates a pending leg', async () => {
  const s = await setup();
  const leg = await redirected(s);
  await s.controller.act('openSettings');
  await s.controller.act('signOut');
  await flush();
  s.controller.handleEvent('webAuthReturned', { url: `https://${HOST}${EXCHANGE}?code=late`, leg });
  await flush();
  assert.deepEqual(loads(s.native), ['/']);
});
