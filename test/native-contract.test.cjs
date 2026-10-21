'use strict';

/*
 * The overlay protocol between shell/controller.js and the two native bootstraps. The Java and
 * Swift sources are read as text: no JVM or Xcode runs here, so this establishes that both
 * platforms implement the same commands and events and keep the hosted page hidden until the
 * overlay reveals it, not how they behave on a device.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FakeNative, FakeView, flush } = require('./helpers/doubles.cjs');
const { createController } = require('../shell/controller.js');

const NATIVE = path.join(__dirname, '..', 'native', 'shell-bootstrap');
const ANDROID = fs.readFileSync(path.join(NATIVE, 'android', 'src', 'main', 'java', 'app', 'merofoundry', 'shell', 'MeroShellPlugin.java'), 'utf8');
const IOS = fs.readFileSync(path.join(NATIVE, 'ios', 'Sources', 'MeroShellPlugin', 'MeroShellPlugin.swift'), 'utf8');
const CONTROLLER = fs.readFileSync(path.join(__dirname, '..', 'shell', 'controller.js'), 'utf8');

const handledCommands = (source) => new Set([...source.matchAll(/case "(\w+)":/g)].map((m) => m[1]));
const emittedEvents = (source) => new Set([...source.matchAll(/emit\("(\w+)"/g)].map((m) => m[1]));

/** Every command the controller sends while driving it through all of its paths. */
async function commandsSentByController() {
  const native = new FakeNative({ lockEnabled: true });
  const controller = createController({ native, view: new FakeView() });
  await controller.start();
  await flush();
  for (const [name, payload] of [
    ['pageLoaded', {}],
    ['insets', { top: 1, right: 0, bottom: 0, left: 0 }],
    ['deepLink', { url: 'https://shop.example.com/a' }],
    ['openSettings', {}],
    ['pageFailed', { url: 'https://shop.example.com/' }],
    ['refreshRequested', { url: 'https://shop.example.com/b' }],
  ]) {
    await controller.handleEvent(name, payload);
  }
  await controller.act('setLock', { enabled: false });
  await controller.act('signOut');
  await controller.act('retry');
  await controller.handleEvent('pageLoaded', {});
  await flush();
  return new Set(native.commands());
}

test('both native bootstraps handle every command the controller sends', async () => {
  const sent = await commandsSentByController();
  assert.deepEqual([...sent].sort(), [
    'applyHostInsets', 'authenticate', 'clearCookies', 'cover', 'loadHost', 'ready', 'reveal', 'setLockEnabled',
  ]);
  for (const [platform, source] of [['android', ANDROID], ['ios', IOS]]) {
    const handled = handledCommands(source);
    for (const cmd of sent) {
      assert.ok(handled.has(cmd), `${platform} handles ${cmd}`);
    }
  }
});

test('both native bootstraps emit only events the controller handles, and the same set', () => {
  const android = emittedEvents(ANDROID);
  const ios = emittedEvents(IOS);
  assert.deepEqual([...android].sort(), [...ios].sort());
  for (const name of android) {
    assert.match(CONTROLLER, new RegExp(`\\b${name}: async function`), `controller handles ${name}`);
  }
  assert.deepEqual([...android].sort(), ['deepLink', 'insets', 'openSettings', 'pageFailed', 'pageLoaded', 'refreshRequested', 'resume']);
});

test('both bootstraps expose the refresh method the hosted page calls, and drop it while the page is covered', () => {
  const HOSTED = fs.readFileSync(path.join(__dirname, '..', 'shell', 'hosted-integration.js'), 'utf8');
  assert.match(HOSTED, /nativeCall\('MeroShell', 'refresh', \{ url: win\.location\.href \}\)/);
  assert.match(ANDROID, /@PluginMethod\s*public void refresh\(PluginCall call\) \{\s*String url = call\.getString\("url", ""\);\s*getActivity\(\)\.runOnUiThread\(\(\) -> \{\s*if \(hosted\.getVisibility\(\) == View\.VISIBLE\) \{\s*emit\("refreshRequested", object\("url", url\)\);/);
  assert.match(IOS, /CAPPluginMethod\(name: "refresh", returnType: CAPPluginReturnPromise\)/);
  assert.match(IOS, /@objc func refresh\(_ call: CAPPluginCall\) \{\s*let url = call\.getString\("url"\) \?\? ""\s*DispatchQueue\.main\.async \{ \[weak self\] in\s*guard let self = self, self\.bridge\?\.webView\?\.scrollView\.isHidden == false else \{ return \}\s*self\.emit\("refreshRequested", \["url": url\]\)/);
  for (const source of [ANDROID, IOS]) {
    assert.doesNotMatch(source, /SwipeRefreshLayout|UIRefreshControl|location\.reload|\.reload\(\)/, 'the reload is the controller\'s loadHost, not a native reload');
  }
});

test('the hosted page is hidden when the bootstrap loads and shown only by the reveal command', () => {
  const load = (source, start) => source.slice(source.indexOf(start), source.indexOf('\n    }', source.indexOf(start)));
  assert.match(load(ANDROID, 'public void load()'), /hosted\.setVisibility\(View\.INVISIBLE\)/);
  assert.match(load(IOS, 'override public func load()'), /hosted\.scrollView\.isHidden = true/);
  assert.equal((ANDROID.match(/setVisibility\(View\.VISIBLE\)/g) || []).length, 1);
  assert.match(ANDROID, /case "reveal":\s*hosted\.setVisibility\(View\.VISIBLE\)/);
  assert.equal((IOS.match(/scrollView\.isHidden = false/g) || []).length, 1);
  assert.match(IOS, /case "reveal":\s*bridge\?\.webView\?\.scrollView\.isHidden = false/);
});

test('the hosted-page script is injected at document start for the configured host only', () => {
  assert.match(ANDROID, /addDocumentStartJavaScript\(hosted, hostedScript, Collections\.singleton\("https:\/\/" \+ host\)\)/);
  assert.match(IOS, /WKUserScript\(source: script, injectionTime: \.atDocumentStart, forMainFrameOnly: true\)/);
  for (const source of [ANDROID, IOS]) {
    assert.match(source, /window\.__meroShellConfig=/);
  }
});

test('native navigation refuses any path that would leave the configured host', () => {
  assert.match(ANDROID, /!path\.startsWith\("\/"\) \|\| !"https"\.equals\(target\.getScheme\(\)\) \|\| !host\.equals\(target\.getHost\(\)\)/);
  assert.match(IOS, /guard path\.hasPrefix\("\/"\), let url = URL\(string: "https:\/\/\\\(host\)\\\(path\)"\), url\.scheme == "https", url\.host == host/);
});

test('cookies are cleared from the WebView cookie stores before the reply that lets sign-out reload', () => {
  assert.match(ANDROID, /removeAllCookies\(removed -> \{\s*cookies\.flush\(\);\s*reply\(id, null\);/);
  assert.match(IOS, /removeData\(ofTypes: \[WKWebsiteDataTypeCookies\], modifiedSince: Date\.distantPast\) \{ \[weak self\] in\s*self\?\.reply\(id, nil\)/);
});

test('the lock covers the hosted page when the app leaves the foreground, except during the prompt', () => {
  assert.match(ANDROID, /handleOnPause\(\) \{\s*if \(lockEnabled\(\) && !authInProgress\) \{\s*cover\(\);/);
  assert.match(IOS, /guard lockEnabled, !authInProgress else \{ return \}\s*cover\(\)/);
});
