'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createChannel, detectTransport } = require('../shell/channel.js');

test('commands are posted as JSON with increasing ids and resolve with the native result', async () => {
  const posted = [];
  const channel = createChannel((message) => posted.push(JSON.parse(message)));
  const first = channel.call('ready');
  const second = channel.call('loadHost', { path: '/a' });
  assert.deepEqual(posted, [
    { id: 1, cmd: 'ready', args: {} },
    { id: 2, cmd: 'loadHost', args: { path: '/a' } },
  ]);
  channel.receive({ type: 'result', id: 2, ok: true, value: null });
  channel.receive(JSON.stringify({ type: 'result', id: 1, ok: true, value: { host: 'x.example.com' } }));
  assert.deepEqual(await first, { host: 'x.example.com' });
  assert.equal(await second, null);
});

test('a failed command rejects with the native error message', async () => {
  const channel = createChannel(() => {});
  const call = channel.call('clearCookies');
  channel.receive({ type: 'result', id: 1, ok: false, error: 'cookie store unavailable' });
  await assert.rejects(call, /cookie store unavailable/);
});

test('events that arrive before a listener is attached are delivered in order once it is', () => {
  const channel = createChannel(() => {});
  channel.receive({ type: 'event', name: 'pageLoaded', payload: { url: 'https://x.example.com/' } });
  channel.receive({ type: 'event', name: 'resume', payload: { backgrounded: true } });
  const seen = [];
  channel.onEvent((name, payload) => seen.push([name, payload]));
  channel.receive({ type: 'event', name: 'openSettings' });
  assert.deepEqual(seen, [
    ['pageLoaded', { url: 'https://x.example.com/' }],
    ['resume', { backgrounded: true }],
    ['openSettings', {}],
  ]);
});

test('unknown result ids and malformed messages are ignored', () => {
  const channel = createChannel(() => {});
  assert.doesNotThrow(() => channel.receive({ type: 'result', id: 99, ok: true }));
  assert.doesNotThrow(() => channel.receive('{not json'));
  assert.doesNotThrow(() => channel.receive(null));
});

test('the Android transport is the MeroShellNative JavaScript interface', () => {
  const sent = [];
  const post = detectTransport({ MeroShellNative: { postMessage: (m) => sent.push(m) } });
  post('{"id":1}');
  assert.deepEqual(sent, ['{"id":1}']);
});

test('the iOS transport is the meroShell WKScriptMessageHandler', () => {
  const sent = [];
  const post = detectTransport({ webkit: { messageHandlers: { meroShell: { postMessage: (m) => sent.push(m) } } } });
  post('{"id":1}');
  assert.deepEqual(sent, ['{"id":1}']);
});

test('without either native transport there is no channel', () => {
  assert.equal(detectTransport({}), null);
});
