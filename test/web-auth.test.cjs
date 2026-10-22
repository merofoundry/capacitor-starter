'use strict';

/*
 * The pure checks behind provider sign-in from the shell (ADR 2026-10-16 v2, Ruling 6): the
 * application id read from the public by-host metadata, the catalog boolean, the exact
 * exchange path a web-authentication return must match, and the Android callback-service links
 * that are intermediate steps rather than returns.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BY_HOST_PATH,
  CATALOG_PATH,
  exchangePath,
  readApplicationId,
  readCatalogProviderSignIn,
  exchangeReturnPath,
  isCallbackServiceLink,
  isExchangeLink,
} = require('../shell/web-auth.js');

const HOST = 'shop.example.com';
const APP = '0f9c2a64-3b1e-4c6d-9a7e-5d2b8c1e4f30';
const OTHER_APP = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const EXCHANGE = `/api/v1/applications/${APP}/auth/oauth/exchange`;
const json = (status, body) => ({ status, body: JSON.stringify(body) });

test('the shell reads the existing public by-host metadata and the application catalog', () => {
  assert.equal(BY_HOST_PATH, '/api/v1/applications/public/by-host');
  assert.equal(CATALOG_PATH, '/.well-known/api-catalog');
});

test('the exchange path is the backend route for exactly this application', () => {
  assert.equal(exchangePath(APP), EXCHANGE);
});

test('the application id is accepted only as a UUID from a 200 by-host answer', () => {
  assert.equal(readApplicationId(json(200, { id: APP, slug: 'shop' })), APP);
  assert.equal(readApplicationId(json(200, { id: APP.toUpperCase() })), APP);
  for (const response of [
    json(404, { id: APP }),
    json(200, { slug: 'shop' }),
    json(200, { id: 'shop' }),
    json(200, { id: `${APP}/../x` }),
    json(200, { id: 42 }),
    { status: 200, body: 'not json' },
    { status: 200, body: '' },
    null,
    undefined,
  ]) {
    assert.equal(readApplicationId(response), null, JSON.stringify(response));
  }
});

test('the catalog boolean is true only when the field is literally true on a 200 answer', () => {
  const on = { linkset: [], mobile_shell: { provider_sign_in: true } };
  assert.equal(readCatalogProviderSignIn(json(200, on)), true);
  for (const response of [
    json(200, { linkset: [] }),
    json(200, { mobile_shell: {} }),
    json(200, { mobile_shell: { provider_sign_in: false } }),
    json(200, { mobile_shell: { provider_sign_in: 'true' } }),
    json(200, { mobile_shell: { provider_sign_in: 1 } }),
    json(200, { mobile_shell: true }),
    json(404, on),
    json(500, on),
    json(301, on),
    { status: 200, body: '{' },
    { status: 200 },
    null,
  ]) {
    assert.equal(readCatalogProviderSignIn(response), false, JSON.stringify(response));
  }
});

test('a valid exchange return keeps its actual path and query, with or without return_to', () => {
  assert.equal(exchangeReturnPath(`https://${HOST}${EXCHANGE}?code=abc123`, HOST, APP), `${EXCHANGE}?code=abc123`);
  assert.equal(
    exchangeReturnPath(`https://${HOST}${EXCHANGE}?code=abc&return_to=%2Forders`, HOST, APP),
    `${EXCHANGE}?code=abc&return_to=%2Forders`,
  );
  assert.equal(exchangeReturnPath(`https://${HOST}${EXCHANGE}?code=x#frag`, HOST, APP), `${EXCHANGE}?code=x`);
  // A deferred callback (ADR 2026-10-16 v2, section 7.2) returns with a pending sign-in id.
  const pending = 'pending=6f1d2c3b-4a59-4e8f-9b7a-0c1d2e3f4a5b';
  assert.equal(exchangeReturnPath(`https://${HOST}${EXCHANGE}?${pending}`, HOST, APP), `${EXCHANGE}?${pending}`);
});

test('exchange returns on any other host, scheme, port, credentials or path are rejected', () => {
  for (const url of [
    `https://evil.example.com${EXCHANGE}?code=a`,
    `https://${HOST}.evil.com${EXCHANGE}?code=a`,
    `http://${HOST}${EXCHANGE}?code=a`,
    `https://${HOST}:8443${EXCHANGE}?code=a`,
    `https://user:pw@${HOST}${EXCHANGE}?code=a`,
    `https://user@${HOST}${EXCHANGE}?code=a`,
    `https://${HOST}/api/v1/applications/${OTHER_APP}/auth/oauth/exchange?code=a`,
    `https://${HOST}${EXCHANGE}/?code=a`,
    `https://${HOST}${EXCHANGE}x?code=a`,
    `https://${HOST}/x${EXCHANGE}?code=a`,
    `https://${HOST}//api/v1/applications/${APP}/auth/oauth/exchange?code=a`,
    `https://${HOST}/api/v1/applications/${APP}/auth/oauth/../oauth/exchange-x?code=a`,
    `https://${HOST}/`,
    'not a url',
    '',
    null,
    42,
  ]) {
    assert.equal(exchangeReturnPath(url, HOST, APP), null, String(url));
  }
});

test('without a validated application id nothing is an exchange return', () => {
  assert.equal(exchangeReturnPath(`https://${HOST}${EXCHANGE}?code=a`, HOST, null), null);
  assert.equal(exchangeReturnPath(`https://${HOST}${EXCHANGE}?code=a`, HOST, 'shop'), null);
});

test('Android callback-service links are recognised as intermediate, not as exchange returns', () => {
  const callback = `https://${HOST}/api/v1/services/9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a/inbound?code=p&state=s`;
  assert.equal(isCallbackServiceLink(callback, HOST), true);
  assert.equal(exchangeReturnPath(callback, HOST, APP), null);
  assert.equal(isCallbackServiceLink(`https://evil.example.com/api/v1/services/9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a/inbound`, HOST), false);
  assert.equal(isCallbackServiceLink(`https://${HOST}/api/v1/services/abc/inbound`, HOST), false);
  assert.equal(isCallbackServiceLink(`https://${HOST}${EXCHANGE}?code=a`, HOST), false);
  assert.equal(isCallbackServiceLink(`https://${HOST}/orders`, HOST), false);
});

test('any application exchange link is recognised so a deep link can never replay one', () => {
  assert.equal(isExchangeLink(`https://${HOST}${EXCHANGE}?code=a`, HOST), true);
  assert.equal(isExchangeLink(`https://${HOST}/api/v1/applications/${OTHER_APP}/auth/oauth/exchange`, HOST), true);
  assert.equal(isExchangeLink(`https://${HOST}/orders`, HOST), false);
  assert.equal(isExchangeLink(`https://evil.example.com${EXCHANGE}`, HOST), false);
});

// Bundled mode (Ruling 5): the bearer exchange path and the returnTo the shell opens locally.

test('the bearer exchange path selects session=bearer and keeps the rest of the query', () => {
  const { bearerExchangePath } = require('../shell/web-auth.js');
  const base = '/api/v1/applications/0f9c2a64-3b1e-4c6d-9a7e-5d2b8c1e4f30/auth/oauth/exchange';
  assert.equal(bearerExchangePath(`${base}?code=a%2Bb`), `${base}?code=a%2Bb&session=bearer`);
  assert.equal(bearerExchangePath(`${base}?pending=p&session=cookie&session=x`), `${base}?pending=p&session=bearer`);
  assert.equal(bearerExchangePath(base), `${base}?session=bearer`);
});

test('returnTo opens locally only as a same-origin path', () => {
  const { localReturnPath } = require('../shell/web-auth.js');
  assert.equal(localReturnPath('/orders?tab=1#top'), '/orders?tab=1#top');
  assert.equal(localReturnPath('/'), '/');
  for (const bad of ['//evil.example.net/', '/\\evil', 'https://evil.example.net/', 'orders', '', '/a\nb', '/a\\b', null, 7]) {
    assert.equal(localReturnPath(bad), null, String(bad));
  }
});
