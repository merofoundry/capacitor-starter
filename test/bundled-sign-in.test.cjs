'use strict';

/*
 * Bundled mode in the shell controller (ADR 2026-10-16 v2, Rulings 5 and 6): provider sign-in
 * completed by the bearer exchange, settings sign-out, the settings mode label and the offline
 * rule. FakeNative stands in for both bootstraps, so these tests show what the controller asks
 * native code to do and what it shows; the native side of the exchange is covered by source
 * inspection in native-contract.test.cjs. Nothing here is evidence of device behaviour.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createController } = require('../shell/controller.js');
const { createView } = require('../shell/view.js');
const { FakeNative, FakeView, flush } = require('./helpers/doubles.cjs');
const { FakeDocument } = require('./helpers/fake-dom.cjs');

const HOST = 'shop.example.com';
const LOCAL = 'capacitor://localhost';
const APP = '0f9c2a64-3b1e-4c6d-9a7e-5d2b8c1e4f30';
const EXCHANGE = `/api/v1/applications/${APP}/auth/oauth/exchange`;
const SIGN_IN = `https://${HOST}/api/v1/services/9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a/inbound?provider=google`;
const BUNDLED = { mode: 'bundled', localOrigin: LOCAL };

const PROBE = {
  '/api/v1/applications/public/by-host': { status: 200, body: JSON.stringify({ id: APP }) },
  '/.well-known/api-catalog': { status: 200, body: JSON.stringify({ mobile_shell: { provider_sign_in: true } }) },
};

async function setup(launch = BUNDLED, { page = `${LOCAL}/login` } = {}) {
  const native = new FakeNative({ providerSignInSupported: true, ...launch });
  native.answer('fetchHost', (args) => PROBE[args.path] || { status: 404, body: '' });
  const view = new FakeView();
  const logged = [];
  const controller = createController({ native, view, log: (...args) => logged.push(args.join(' ')), schedule: () => {} });
  await controller.start();
  await flush();
  controller.handleEvent('pageLoaded', { url: page });
  await flush();
  return { native, view, logged, controller };
}

const lastArgs = (native, cmd) => native.calls.filter((c) => c.cmd === cmd).at(-1).args;
const loads = (native) => native.calls.filter((c) => c.cmd === 'loadHost').map((c) => c.args.path);

/** Run a leg up to an open web-authentication session and return its id. */
async function openLeg(s) {
  s.controller.handleEvent('providerSignInRequested', { url: SIGN_IN });
  await flush();
  const leg = lastArgs(s.native, 'startProviderSignIn').leg;
  s.controller.handleEvent('providerRedirect', { url: 'https://accounts.google.com/o/oauth2/v2/auth', leg });
  await flush();
  return leg;
}

async function returned(s, query = '?code=c1&return_to=%2Forders') {
  const leg = await openLeg(s);
  s.controller.handleEvent('webAuthReturned', { url: `https://${HOST}${EXCHANGE}${query}`, leg });
  await flush();
  return leg;
}

// Provider completion

test('bundled: a validated return is redeemed natively with session=bearer, never loaded in the WebView', async () => {
  const s = await setup();
  s.native.hold('exchangeSession');
  const leg = await returned(s);
  assert.deepEqual(lastArgs(s.native, 'exchangeSession'), { path: `${EXCHANGE}?code=c1&return_to=%2Forders&session=bearer`, leg });
  assert.ok(!loads(s.native).some((p) => p.startsWith(EXCHANGE)), 'the exchange path is not loaded in the hosted WebView');
});

test('bundled: session=bearer replaces any session value the return carried', async () => {
  const s = await setup();
  s.native.hold('exchangeSession');
  await returned(s, '?code=c1&session=cookie');
  assert.equal(lastArgs(s.native, 'exchangeSession').path, `${EXCHANGE}?code=c1&session=bearer`);
});

test('bundled: exchange URL validation is retained; an invalid return is never redeemed', async () => {
  for (const url of [
    `https://evil.example.net${EXCHANGE}?code=c`,
    `https://${HOST}/api/v1/applications/11111111-2222-4333-8444-555555555555/auth/oauth/exchange?code=c`,
    `http://${HOST}${EXCHANGE}?code=c`,
    `https://${HOST}/login`,
  ]) {
    const s = await setup();
    const leg = await openLeg(s);
    s.controller.handleEvent('webAuthReturned', { url, leg });
    await flush();
    assert.equal(s.native.count('exchangeSession'), 0, url);
  }
});

test('bundled: success opens the validated returnTo in the bundled site, then announces a token-free session change', async () => {
  const s = await setup();
  s.native.answer('exchangeSession', () => ({ status: 'signedIn', returnTo: '/orders?tab=open#top' }));
  await returned(s);
  assert.deepEqual(s.native.calls.at(-1), { cmd: 'loadHost', args: { path: '/orders?tab=open#top' } });
  assert.equal(s.native.count('sessionChanged'), 0, 'announced only once the return page has loaded');
  s.controller.handleEvent('pageLoaded', { url: `${LOCAL}/orders?tab=open#top` });
  await flush();
  assert.deepEqual(lastArgs(s.native, 'sessionChanged'), { signedIn: true });
  assert.equal(s.native.count('sessionChanged'), 1);
  s.controller.handleEvent('pageLoaded', { url: `${LOCAL}/orders` });
  await flush();
  assert.equal(s.native.count('sessionChanged'), 1, 'the leg has ended');
  assert.equal(s.view.current.name, 'privacy', 'the bundled page is shown');
});

test('bundled: a returnTo that would leave the bundled site opens its root instead', async () => {
  for (const returnTo of ['//evil.example.net/x', 'https://evil.example.net/', '/\\evil', 'orders', '', null]) {
    const s = await setup();
    s.native.answer('exchangeSession', () => ({ status: 'signedIn', returnTo }));
    await returned(s);
    assert.deepEqual(s.native.calls.at(-1), { cmd: 'loadHost', args: { path: '/' } }, String(returnTo));
  }
});

for (const status of ['refused', 'malformed', 'storageFailed', 'cancelled', 'surprise']) {
  test(`bundled: an exchange answered ${status} ends the leg without navigating or going offline`, async () => {
    const s = await setup();
    s.native.answer('exchangeSession', () => ({ status }));
    await returned(s);
    const before = loads(s.native).length;
    assert.equal(s.native.count('sessionChanged'), 0);
    assert.notEqual(s.view.current.name, 'offline');
    s.controller.handleEvent('providerSignInRequested', { url: SIGN_IN });
    await flush();
    assert.equal(s.native.count('startProviderSignIn'), 2, 'a new leg may start');
    assert.equal(loads(s.native).length, before);
  });
}

test('bundled: a malformed or rejected exchange answer is treated as a refusal', async () => {
  for (const answer of [() => undefined, () => 'signedIn', () => { throw new Error('refused to exchange outside the application exchange route'); }]) {
    const s = await setup();
    s.native.answer('exchangeSession', answer);
    await returned(s);
    assert.equal(s.native.count('sessionChanged'), 0);
    assert.notEqual(s.view.current.name, 'offline');
    assert.ok(!loads(s.native).some((p) => p !== '/' && p !== EXCHANGE), 'no navigation');
  }
});

test('bundled: an unreachable host during the exchange shows the offline screen and retry reloads the origin page', async () => {
  const s = await setup(BUNDLED, { page: `${LOCAL}/account?x=1` });
  s.native.answer('exchangeSession', () => ({ status: 'unreachable' }));
  await returned(s);
  assert.equal(s.view.current.name, 'offline');
  await s.controller.act('retry');
  assert.deepEqual(s.native.calls.at(-1), { cmd: 'loadHost', args: { path: '/account?x=1' } });
});

test('bundled: the shell stays responsive while the exchange is in flight, and a late answer for an ended leg is ignored', async () => {
  const s = await setup({ ...BUNDLED, lockEnabled: true });
  s.native.hold('exchangeSession');
  await returned(s);
  s.native.hold('authenticate');
  s.controller.handleEvent('resume', { backgrounded: true });
  await flush();
  assert.equal(s.view.current.name, 'lock', 'the resume was handled while the exchange was pending');
  assert.ok(s.native.commands().includes('cancelProviderSignIn'));
  await s.native.release('exchangeSession', { status: 'signedIn', returnTo: '/orders' });
  await flush();
  assert.ok(!loads(s.native).includes('/orders'), 'no navigation behind the lock for an ended leg');
  assert.equal(s.native.count('sessionChanged'), 0);
});

test('bundled: no token reaches the controller or any command it sends', async () => {
  const s = await setup();
  s.native.answer('exchangeSession', () => ({ status: 'signedIn', returnTo: '/orders' }));
  await returned(s);
  s.controller.handleEvent('pageLoaded', { url: `${LOCAL}/orders` });
  await flush();
  assert.doesNotMatch(JSON.stringify(s.native.calls), /accessToken|refreshToken|token/i);
});

test('remote: the return is still loaded in the hosted WebView and no bearer exchange is used', async () => {
  const s = await setup({ mode: 'remote' }, { page: `https://${HOST}/login` });
  await returned(s);
  assert.equal(s.native.count('exchangeSession'), 0);
  assert.deepEqual(s.native.calls.at(-1), { cmd: 'loadHost', args: { path: `${EXCHANGE}?code=c1&return_to=%2Forders` } });
  s.controller.handleEvent('pageLoaded', { url: `https://${HOST}/orders` });
  await flush();
  assert.equal(s.native.count('sessionChanged'), 0);
});

// Offline

test('bundled: a failed local page load does not show the offline screen', async () => {
  const s = await setup();
  s.controller.handleEvent('pageFailed', { url: `${LOCAL}/broken`, code: -1 });
  await flush();
  assert.notEqual(s.view.current.name, 'offline');
  assert.ok(s.logged.some((line) => /ignored a failed load/.test(line)));
});

test('bundled: a failed navigation to the application host outside a sign-in leg does not show the offline screen', async () => {
  const s = await setup();
  s.controller.handleEvent('pageFailed', { url: `https://${HOST}/elsewhere`, code: -1009 });
  await flush();
  assert.notEqual(s.view.current.name, 'offline');
});

test('bundled: a failed hosted navigation to https://<host> during a provider leg shows the offline screen', async () => {
  const s = await setup(BUNDLED, { page: `${LOCAL}/login?next=%2Fa` });
  s.controller.handleEvent('providerSignInRequested', { url: SIGN_IN });
  await flush();
  s.controller.handleEvent('pageFailed', { url: SIGN_IN, code: -1009 });
  await flush();
  assert.equal(s.view.current.name, 'offline');
  assert.ok(s.native.commands().includes('cancelProviderSignIn'));
  await s.controller.act('retry');
  assert.deepEqual(s.native.calls.at(-1), { cmd: 'loadHost', args: { path: '/login?next=%2Fa' } }, 'retry reloads the local page');
});

test('bundled: a local load failure during a leg does not show the offline screen', async () => {
  const s = await setup();
  s.controller.handleEvent('providerSignInRequested', { url: SIGN_IN });
  await flush();
  s.controller.handleEvent('pageFailed', { url: `${LOCAL}/login`, code: -1 });
  await flush();
  assert.notEqual(s.view.current.name, 'offline');
});

test('remote: a failed load still shows the offline screen', async () => {
  const s = await setup({ mode: 'remote' }, { page: `https://${HOST}/` });
  s.controller.handleEvent('pageFailed', { url: `https://${HOST}/orders`, code: -1009 });
  await flush();
  assert.equal(s.view.current.name, 'offline');
});

// Settings

test('bundled: sign-out clears the saved pair, then the WebView cookies, then reloads the bundled root', async () => {
  const s = await setup();
  s.controller.handleEvent('openSettings', {});
  await flush();
  s.native.hold('clearSavedSession');
  const signingOut = s.controller.act('signOut');
  await flush();
  assert.equal(s.native.commands().at(-1), 'clearSavedSession');
  assert.equal(s.native.count('clearCookies'), 0, 'cookies wait for the pair');
  await s.native.release('clearSavedSession');
  await signingOut;
  const cmds = s.native.commands();
  assert.ok(cmds.lastIndexOf('clearSavedSession') < cmds.lastIndexOf('clearCookies'));
  assert.ok(cmds.lastIndexOf('clearCookies') < cmds.lastIndexOf('loadHost'));
  assert.equal(loads(s.native).at(-1), '/');
  assert.ok(!cmds.some((c) => /revoke|logout/i.test(c)), 'no server revocation');
});

test('bundled: if the saved pair cannot be cleared, nothing else is cleared or reloaded and the error is shown', async () => {
  const s = await setup();
  s.controller.handleEvent('openSettings', {});
  await flush();
  s.native.hold('clearSavedSession');
  const signingOut = s.controller.act('signOut');
  await flush();
  await s.native.fail('clearSavedSession', new Error('secure session storage is unavailable'));
  await signingOut;
  assert.equal(s.native.count('clearCookies'), 0);
  assert.equal(s.native.count('loadHost'), 0);
  assert.equal(s.view.current.name, 'settings');
  assert.match(s.view.current.data.error, /saved sign-in/);
});

test('remote: sign-out is unchanged and never touches the saved pair', async () => {
  const s = await setup({ mode: 'remote' }, { page: `https://${HOST}/` });
  s.controller.handleEvent('openSettings', {});
  await flush();
  await s.controller.act('signOut');
  assert.equal(s.native.count('clearSavedSession'), 0);
  assert.ok(s.native.commands().includes('clearCookies'));
  assert.equal(loads(s.native).at(-1), '/');
});

for (const [mode, label] of [['bundled', 'Bundled'], ['remote', 'Remote']]) {
  test(`${mode}: settings show ${label} beside the host and no token`, async () => {
    const s = await setup({ ...BUNDLED, mode }, { page: mode === 'bundled' ? `${LOCAL}/` : `https://${HOST}/` });
    s.controller.handleEvent('openSettings', {});
    await flush();
    const data = s.view.current.data;
    assert.equal(s.view.current.name, 'settings');
    assert.equal(data.host, HOST);
    assert.equal(data.modeLabel, label);
    assert.match(data.signOutHint, mode === 'bundled' ? /saved sign-in.*reloads the app/ : /^Sign out removes this app's cookies on this device and reloads the site\.$/);

    const html = fs.readFileSync(path.join(__dirname, '..', 'shell', 'index.html'), 'utf8');
    const doc = new FakeDocument(html);
    createView(doc, () => {}).show('settings', data);
    const settings = doc.querySelector('[data-view="settings"]');
    const serverRow = settings.querySelector('[data-field="host"]').parent;
    assert.equal(serverRow.tagName, 'DD');
    assert.equal(serverRow.textContent.replace(/\s+/g, ' ').trim(), `${HOST} ${label}`);
    assert.equal(settings.querySelector('[data-field="signOutHint"]').textContent, data.signOutHint);
    assert.doesNotMatch(settings.textContent, /token|Bearer/i);
  });
}
