'use strict';

/*
 * MeroFoundryShell.bearer (shell/bearer-client.js) against a fetch double and an in-memory
 * session store. The double answers like the consumer routes of ADR 2026-10-16 v2, Ruling 5;
 * nothing here reaches a MeroFoundry host, so it shows what the client sends and how it reacts,
 * not that a deployment accepts it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBearerClient, BearerError } = require('../shell/bearer-client.js');

const HOST = 'shop.example.com';
const APP = '0f9c2a64-3b1e-4c6d-9a7e-5d2b8c1e4f30';
const LOGIN_MODEL = '5a1d0c3e-8b7f-4e2a-9c6d-1f0e2d3c4b5a';
const LOGOUT_MODEL = '7c2e1d4f-9a8b-4c3d-8e7f-6a5b4c3d2e1f';
const PAIR = { accessToken: 'access-1-secret', refreshToken: 'refresh-1-secret' };
const ROTATED = { accessToken: 'access-2-secret', refreshToken: 'refresh-2-secret' };

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Records every request; `routes` answers by "METHOD path" (path without the query). */
function fetchDouble(routes) {
  const requests = [];
  async function fetch(input, init) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === 'GET' ? null : await request.clone().text();
    requests.push({ method: request.method, url: url.href, path: url.pathname, query: url.search, headers: Object.fromEntries(request.headers), credentials: init && init.credentials, body: body ? JSON.parse(body) : null });
    const route = routes[`${request.method} ${url.origin === `https://${HOST}` ? url.pathname : url.href}`];
    if (!route) {
      return new Response('', { status: 404 });
    }
    return route(requests.at(-1));
  }
  return { fetch, requests };
}

function memorySession(initial = null) {
  const store = { pair: initial, saves: [], clears: 0 };
  store.api = {
    load: async () => (store.pair ? { ...store.pair } : null),
    save: async (pair) => {
      store.pair = { ...pair };
      store.saves.push({ ...pair });
    },
    clear: async () => {
      store.pair = null;
      store.clears += 1;
    },
  };
  return store;
}

const BY_HOST = { 'GET /api/v1/applications/public/by-host': () => json(200, { id: APP, slug: 'shop' }) };

function client(routes, session = memorySession()) {
  const double = fetchDouble({ ...BY_HOST, ...routes });
  const bearer = createBearerClient({
    host: HOST,
    fetch: double.fetch,
    session: session.api,
    Request,
    Headers,
    baseUrl: () => 'capacitor://localhost/orders',
  });
  return { bearer, session, requests: double.requests };
}

const withoutDiscovery = (requests) => requests.filter((r) => !r.path.endsWith('/public/by-host'));

// login

test('login submits the login model with session=bearer and X-Requested-With, then saves the pair', async () => {
  const s = client({
    [`POST /api/v1/models/${LOGIN_MODEL}/records`]: () => json(200, { ...PAIR, tokenType: 'bearer', session: {}, redirect: '/welcome' }),
  });
  const result = await s.bearer.login(LOGIN_MODEL, { email: 'a@example.com', password: 'pw' });
  assert.deepEqual(result, { redirect: '/welcome' }, 'the caller gets no token');
  const [login] = withoutDiscovery(s.requests);
  assert.equal(login.url, `https://${HOST}/api/v1/models/${LOGIN_MODEL}/records?application_id=${APP}`);
  assert.deepEqual(login.body, { data: { email: 'a@example.com', password: 'pw', session: 'bearer' } });
  assert.equal(login.headers['x-requested-with'], 'XMLHttpRequest');
  assert.equal(login.credentials, 'omit');
  assert.equal(login.headers.authorization, undefined);
  assert.deepEqual(s.session.saves, [PAIR]);
});

test('the application UUID comes from the host metadata, once, and never from the native app id', async () => {
  const s = client({
    [`POST /api/v1/models/${LOGIN_MODEL}/records`]: () => json(200, PAIR),
  });
  await s.bearer.login(LOGIN_MODEL, { email: 'a@example.com', password: 'pw' });
  await s.bearer.login(LOGIN_MODEL, { email: 'a@example.com', password: 'pw' });
  const discovery = s.requests.filter((r) => r.path === '/api/v1/applications/public/by-host');
  assert.equal(discovery.length, 1);
  assert.equal(discovery[0].url, `https://${HOST}/api/v1/applications/public/by-host`);
  assert.ok(s.requests.every((r) => !/com\.example/.test(r.url)));
});

test('login refuses an unvalidated application id and sends no credentials', async () => {
  const s = client({
    'GET /api/v1/applications/public/by-host': () => json(200, { id: 'com.example.shop' }),
    [`POST /api/v1/models/${LOGIN_MODEL}/records`]: () => json(200, PAIR),
  });
  await assert.rejects(s.bearer.login(LOGIN_MODEL, { email: 'a@example.com', password: 'pw' }), (error) => {
    assert.ok(error instanceof BearerError);
    assert.equal(error.code, 'unknown_application');
    return true;
  });
  assert.equal(withoutDiscovery(s.requests).length, 0);
  assert.deepEqual(s.session.saves, []);
});

test('a refused login rejects with the status and detail and saves nothing', async () => {
  const s = client({
    [`POST /api/v1/models/${LOGIN_MODEL}/records`]: () => json(400, { detail: 'session_transport_not_available' }),
  });
  await assert.rejects(s.bearer.login(LOGIN_MODEL, { email: 'a@example.com', password: 'pw' }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'session_transport_not_available');
    return true;
  });
  assert.deepEqual(s.session.saves, []);
});

test('a login answer without a pair is malformed and saves nothing', async () => {
  const s = client({
    [`POST /api/v1/models/${LOGIN_MODEL}/records`]: () => json(200, { accessToken: null, refreshToken: null, tokenType: 'bearer' }),
  });
  await assert.rejects(s.bearer.login(LOGIN_MODEL, { email: 'a@example.com', password: 'pw' }), /without a bearer session/);
  assert.deepEqual(s.session.saves, []);
});

test('login validates the model id and credentials before any request', async () => {
  const s = client({});
  for (const [model, credentials] of [['users', { email: 'a', password: 'b' }], [LOGIN_MODEL, { email: 'a' }], [LOGIN_MODEL, null]]) {
    await assert.rejects(s.bearer.login(model, credentials), BearerError);
  }
  assert.equal(s.requests.length, 0);
});

// fetch

test('an authenticated fetch to the host carries the saved bearer and no cookies', async () => {
  const s = client({ 'GET /api/v1/orders': () => json(200, { items: [] }) }, memorySession(PAIR));
  const response = await s.bearer.fetch('https://shop.example.com/api/v1/orders', { headers: { Accept: 'application/json' } });
  assert.equal(response.status, 200);
  const [request] = s.requests;
  assert.equal(request.headers.authorization, 'Bearer access-1-secret');
  assert.equal(request.headers.accept, 'application/json');
  assert.equal(request.headers.cookie, undefined);
  assert.equal(s.requests.length, 1, 'no refresh and no discovery for a successful call');
});

test('after a 401 the pair is refreshed by body, saved, and the request retried once', async () => {
  let calls = 0;
  const s = client({
    'POST /api/v1/orders': (req) => {
      calls += 1;
      return json(req.headers.authorization === 'Bearer access-2-secret' ? 201 : 401, {});
    },
    [`POST /api/v1/applications/${APP}/auth/refresh`]: () => json(200, { ...ROTATED, tokenType: 'bearer' }),
  }, memorySession(PAIR));
  const response = await s.bearer.fetch('https://shop.example.com/api/v1/orders', { method: 'POST', body: JSON.stringify({ n: 1 }) });
  assert.equal(response.status, 201);
  assert.equal(calls, 2);
  const work = withoutDiscovery(s.requests);
  assert.deepEqual(work.map((r) => `${r.method} ${r.path}`), [
    'POST /api/v1/orders', `POST /api/v1/applications/${APP}/auth/refresh`, 'POST /api/v1/orders',
  ]);
  assert.deepEqual(work[1].body, { data: { refresh_token: 'refresh-1-secret' } });
  assert.equal(work[1].headers.authorization, undefined);
  assert.equal(work[1].credentials, 'omit');
  assert.deepEqual(work[2].body, { n: 1 }, 'the retried request keeps its body');
  assert.deepEqual(s.session.saves, [ROTATED]);
  assert.deepEqual(s.session.pair, ROTATED);
});

test('a second 401 after the refresh is returned as is: one retry only', async () => {
  const s = client({
    'GET /api/v1/orders': () => json(401, {}),
    [`POST /api/v1/applications/${APP}/auth/refresh`]: () => json(200, ROTATED),
  }, memorySession(PAIR));
  const response = await s.bearer.fetch('https://shop.example.com/api/v1/orders');
  assert.equal(response.status, 401);
  assert.deepEqual(withoutDiscovery(s.requests).map((r) => r.path), ['/api/v1/orders', `/api/v1/applications/${APP}/auth/refresh`, '/api/v1/orders']);
});

test('a refused refresh is terminal: the pair is cleared and the original 401 returned', async () => {
  const s = client({
    'GET /api/v1/orders': () => json(401, { detail: 'expired' }),
    [`POST /api/v1/applications/${APP}/auth/refresh`]: () => json(401, { detail: 'Invalid refresh token' }),
  }, memorySession(PAIR));
  const response = await s.bearer.fetch('https://shop.example.com/api/v1/orders');
  assert.equal(response.status, 401);
  assert.equal(s.session.pair, null);
  assert.equal(await s.bearer.signedIn(), false);
  assert.equal(withoutDiscovery(s.requests).filter((r) => r.path === '/api/v1/orders').length, 1, 'no retry');
});

test('a refresh that fails for another reason keeps the pair and returns the original 401', async () => {
  const s = client({
    'GET /api/v1/orders': () => json(401, {}),
    [`POST /api/v1/applications/${APP}/auth/refresh`]: () => json(503, {}),
  }, memorySession(PAIR));
  assert.equal((await s.bearer.fetch('https://shop.example.com/api/v1/orders')).status, 401);
  assert.deepEqual(s.session.pair, PAIR);
});

test('concurrent 401s for the same pair share one refresh', async () => {
  const s = client({
    'GET /api/v1/orders': (req) => json(req.headers.authorization === 'Bearer access-2-secret' ? 200 : 401, {}),
    [`POST /api/v1/applications/${APP}/auth/refresh`]: () => json(200, ROTATED),
  }, memorySession(PAIR));
  const answers = await Promise.all([1, 2, 3].map(() => s.bearer.fetch('https://shop.example.com/api/v1/orders')));
  assert.deepEqual(answers.map((r) => r.status), [200, 200, 200]);
  assert.equal(s.requests.filter((r) => r.path.endsWith('/auth/refresh')).length, 1);
});

test('without a saved pair a request goes out unauthenticated and nothing is refreshed', async () => {
  const s = client({ 'GET /api/v1/orders': () => json(401, {}) });
  const response = await s.bearer.fetch('https://shop.example.com/api/v1/orders');
  assert.equal(response.status, 401);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].headers.authorization, undefined);
});

test('the bearer is never sent to another origin, including the bundled site itself', async () => {
  const s = client({
    'GET https://cdn.example.net/data.json': () => json(200, {}),
    'GET capacitor://localhost/data.json': () => json(200, {}),
  }, memorySession(PAIR));
  await s.bearer.fetch('https://cdn.example.net/data.json');
  await s.bearer.fetch('/data.json');
  assert.deepEqual(s.requests.map((r) => [r.url, r.headers.authorization]), [
    ['https://cdn.example.net/data.json', undefined],
    ['capacitor://localhost/data.json', undefined],
  ]);
});

test('the client never reads document.cookie', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'shell', 'bearer-client.js'), 'utf8');
  assert.doesNotMatch(source, /document\.cookie|credentials: 'include'/);
  assert.doesNotMatch(source, /setInterval|setTimeout|localStorage|sessionStorage|indexedDB|caches\./, 'no background refresh, queue or offline store');
});

// logout and signedIn

test('logout submits the logout model with the bearer and clears the pair', async () => {
  const s = client({ [`POST /api/v1/models/${LOGOUT_MODEL}/records`]: () => json(200, { ok: true }) }, memorySession(PAIR));
  assert.equal(await s.bearer.signedIn(), true);
  assert.deepEqual(await s.bearer.logout(LOGOUT_MODEL), { revoked: true });
  const [logout] = withoutDiscovery(s.requests);
  assert.equal(logout.url, `https://${HOST}/api/v1/models/${LOGOUT_MODEL}/records?application_id=${APP}`);
  assert.equal(logout.headers.authorization, 'Bearer access-1-secret');
  assert.deepEqual(logout.body, { data: {} });
  assert.equal(s.session.pair, null);
  assert.equal(await s.bearer.signedIn(), false);
});

test('logout clears the pair even when the server cannot revoke it', async () => {
  for (const route of [() => json(401, {}), () => Promise.reject(new TypeError('offline'))]) {
    const s = client({ [`POST /api/v1/models/${LOGOUT_MODEL}/records`]: route }, memorySession(PAIR));
    assert.deepEqual(await s.bearer.logout(LOGOUT_MODEL), { revoked: false });
    assert.equal(s.session.pair, null);
  }
});

test('logout without a pair sends nothing and still clears', async () => {
  const s = client({});
  assert.deepEqual(await s.bearer.logout(LOGOUT_MODEL), { revoked: false });
  assert.equal(s.requests.length, 0);
  assert.equal(s.session.clears, 1);
});

test('signedIn reflects whether a pair is saved', async () => {
  const session = memorySession();
  const s = client({ [`POST /api/v1/models/${LOGIN_MODEL}/records`]: () => json(200, PAIR) }, session);
  assert.equal(await s.bearer.signedIn(), false);
  await s.bearer.login(LOGIN_MODEL, { email: 'a@example.com', password: 'pw' });
  assert.equal(await s.bearer.signedIn(), true);
});

test('errors carry no token', async () => {
  const s = client({
    [`POST /api/v1/models/${LOGIN_MODEL}/records`]: () => json(403, { detail: 'csrf_header_required' }),
  }, memorySession(PAIR));
  const error = await s.bearer.login(LOGIN_MODEL, { email: 'a@example.com', password: 'pw' }).catch((e) => e);
  assert.doesNotMatch(JSON.stringify({ message: error.message, code: error.code, status: error.status }), /secret/);
});
