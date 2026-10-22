'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDeepLink, resolveLocalPage } = require('../shell/deep-link.js');

const HOST = 'shop.example.com';

test('a link on the configured host resolves to its path, query and fragment', () => {
  assert.equal(resolveDeepLink('https://shop.example.com/orders/42?tab=items#line-3', HOST), '/orders/42?tab=items#line-3');
  assert.equal(resolveDeepLink('https://shop.example.com', HOST), '/');
  assert.equal(resolveDeepLink('https://SHOP.example.com/a', HOST), '/a');
  assert.equal(resolveDeepLink('https://shop.example.com:443/a', HOST), '/a');
});

test('links that would leave the configured host are rejected', () => {
  const rejected = [
    'http://shop.example.com/orders',
    'https://evil.example.com/orders',
    'https://shop.example.com.evil.com/orders',
    'https://evilshop.example.com/',
    'https://sub.shop.example.com/',
    'https://evil.com/shop.example.com',
    'https://shop.example.com@evil.com/',
    'https://user:pass@shop.example.com/',
    'https://shop.example.com:8443/',
    'myapp://shop.example.com/orders',
    'javascript:alert(1)//shop.example.com',
    'file:///shop.example.com/etc',
    '//shop.example.com/orders',
    '/orders/42',
    'not a url',
    '',
  ];
  for (const url of rejected) {
    assert.equal(resolveDeepLink(url, HOST), null, url);
  }
});

test('non-string input is rejected', () => {
  for (const url of [undefined, null, 1, {}]) {
    assert.equal(resolveDeepLink(url, HOST), null);
  }
});

test('the resolved path can never re-target another host when appended to the configured origin', () => {
  for (const url of ['https://shop.example.com//evil.com/x', 'https://shop.example.com/\\evil.com', 'https://shop.example.com/%2F%2Fevil.com']) {
    const resolved = resolveDeepLink(url, HOST);
    assert.ok(resolved, url);
    assert.equal(new URL(`https://${HOST}${resolved}`).hostname, HOST, url);
  }
});

test('a page of the bundled site resolves on its local origin only', () => {
  assert.equal(resolveLocalPage('capacitor://localhost/orders?x=1#a', 'capacitor://localhost'), '/orders?x=1#a');
  assert.equal(resolveLocalPage('https://localhost/', 'https://localhost'), '/');
  for (const [url, origin] of [
    ['https://shop.example.com/orders', 'capacitor://localhost'],
    ['https://localhost/orders', 'capacitor://localhost'],
    ['capacitor://localhost/orders', 'https://localhost'],
    ['https://localhost:8443/orders', 'https://localhost'],
    ['https://user@localhost/orders', 'https://localhost'],
    ['not a url', 'https://localhost'],
    ['https://localhost/orders', ''],
    [undefined, 'https://localhost'],
  ]) {
    assert.equal(resolveLocalPage(url, origin), null, `${url} on ${origin}`);
  }
});
