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
const ANDROID_CLIENT = fs.readFileSync(path.join(NATIVE, 'android', 'src', 'main', 'java', 'app', 'merofoundry', 'shell', 'ShellWebViewClient.java'), 'utf8');
const ANDROID_MANIFEST = fs.readFileSync(path.join(NATIVE, 'android', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
const ANDROID_GRADLE = fs.readFileSync(path.join(NATIVE, 'android', 'build.gradle'), 'utf8');
const IOS_PROXY = fs.readFileSync(path.join(NATIVE, 'ios', 'Sources', 'MeroShellPlugin', 'ShellNavigationProxy.swift'), 'utf8');
const ANDROID_OVERLAY = fs.readFileSync(path.join(NATIVE, 'android', 'src', 'main', 'java', 'app', 'merofoundry', 'shell', 'ShellOverlay.java'), 'utf8');
const IOS_OVERLAY = fs.readFileSync(path.join(NATIVE, 'ios', 'Sources', 'MeroShellPlugin', 'ShellOverlay.swift'), 'utf8');
const ANDROID_STORE = fs.readFileSync(path.join(NATIVE, 'android', 'src', 'main', 'java', 'app', 'merofoundry', 'shell', 'ShellSessionStore.java'), 'utf8');
const IOS_STORE = fs.readFileSync(path.join(NATIVE, 'ios', 'Sources', 'MeroShellPlugin', 'ShellSessionStore.swift'), 'utf8');
const ANDROID_EXCHANGE = fs.readFileSync(path.join(NATIVE, 'android', 'src', 'main', 'java', 'app', 'merofoundry', 'shell', 'ShellSessionExchange.java'), 'utf8');
const IOS_EXCHANGE = fs.readFileSync(path.join(NATIVE, 'ios', 'Sources', 'MeroShellPlugin', 'ShellSessionExchange.swift'), 'utf8');
const ANDROID_PUSH = fs.readFileSync(path.join(NATIVE, 'android', 'src', 'main', 'java', 'app', 'merofoundry', 'shell', 'ShellPush.java'), 'utf8');
const ANDROID_MESSAGING = fs.readFileSync(path.join(NATIVE, 'android', 'src', 'main', 'java', 'app', 'merofoundry', 'shell', 'MeroShellMessagingService.java'), 'utf8');
const IOS_PUSH = fs.readFileSync(path.join(NATIVE, 'ios', 'Sources', 'MeroShellPlugin', 'ShellPush.swift'), 'utf8');
const NATIVE_SOURCES = {
  android: [ANDROID, ANDROID_CLIENT, ANDROID_OVERLAY, ANDROID_STORE, ANDROID_EXCHANGE, ANDROID_PUSH, ANDROID_MESSAGING],
  ios: [IOS, IOS_PROXY, IOS_OVERLAY, IOS_STORE, IOS_EXCHANGE, IOS_PUSH],
};
// Custom Tabs report neither a cancellation nor an error: Android reports that the tab closed and
// the controller decides after a grace period. ASWebAuthenticationSession reports its own end.
const ANDROID_ONLY_EVENTS = ['webAuthClosed'];
const IOS_ONLY_EVENTS = ['webAuthCancelled', 'webAuthFailed'];

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
  return new Set([
    ...native.commands(),
    ...(await providerSignInCommands()),
    ...(await providerSignInCommands({ mode: 'bundled', localOrigin: 'capacitor://localhost' })),
    ...(await pushCommands()),
  ]);
}

/** The commands of push: the application id, a rejected and an accepted tap, settings, sign-out. */
async function pushCommands() {
  const app = '0f9c2a64-3b1e-4c6d-9a7e-5d2b8c1e4f30';
  const native = new FakeNative({ pushSupported: true });
  native.answer('fetchHost', (args) => ({ status: 200, body: JSON.stringify(args.path.includes('by-host') ? { id: app } : {}) }));
  native.answer('disablePush', () => ({ ok: false }));
  const controller = createController({ native, view: new FakeView(), schedule: () => {} });
  await controller.start();
  await flush();
  await controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  await controller.handleEvent('pushTapped', { path: '//elsewhere' });
  await controller.handleEvent('pushTapped', { path: '/orders/7' });
  await controller.act('openSettings');
  await controller.act('signOut');
  await flush();
  return native.commands();
}

/** The commands of one provider sign-in leg, from request to an exchange return, then sign-out. */
async function providerSignInCommands(launch = {}) {
  const app = '0f9c2a64-3b1e-4c6d-9a7e-5d2b8c1e4f30';
  const native = new FakeNative({ providerSignInSupported: true, ...launch });
  native.answer('exchangeSession', () => ({ status: 'signedIn', returnTo: '/orders' }));
  native.answer('fetchHost', (args) => ({
    status: 200,
    body: JSON.stringify(args.path.includes('by-host') ? { id: app } : { mobile_shell: { provider_sign_in: true } }),
  }));
  const controller = createController({ native, view: new FakeView() });
  await controller.start();
  await flush();
  await controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/' });
  await controller.handleEvent('providerSignInRequested', { url: 'https://shop.example.com/sign-in' });
  await controller.handleEvent('pageLoaded', { url: 'https://shop.example.com/sign-in' });
  await controller.handleEvent('providerSignInRequested', { url: 'https://shop.example.com/sign-in' });
  const leg = native.calls.filter((c) => c.cmd === 'startProviderSignIn').at(-1).args.leg;
  await controller.handleEvent('providerRedirect', { url: 'https://accounts.example.com/auth', leg });
  await controller.handleEvent('webAuthReturned', { url: `https://shop.example.com/api/v1/applications/${app}/auth/oauth/exchange?code=c`, leg });
  await flush();
  await controller.handleEvent('pageLoaded', { url: 'capacitor://localhost/orders' });
  await controller.act('signOut');
  return native.commands();
}

test('both native bootstraps handle every command the controller sends', async () => {
  const sent = await commandsSentByController();
  assert.deepEqual([...sent].sort(), [
    'applyHostInsets', 'authenticate', 'cancelProviderSignIn', 'clearCookies', 'clearSavedSession', 'cover',
    'disablePush', 'exchangeSession', 'fetchHost', 'getPushState', 'loadHost', 'openWebAuth', 'pushEvent', 'ready',
    'resetPush', 'reveal', 'sessionChanged', 'setHostCapabilities', 'setLockEnabled', 'setPushApplication',
    'startProviderSignIn',
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
  assert.deepEqual(
    [...android].filter((name) => !ANDROID_ONLY_EVENTS.includes(name)).sort(),
    [...ios].filter((name) => !IOS_ONLY_EVENTS.includes(name)).sort(),
  );
  assert.deepEqual([...ios].filter((name) => IOS_ONLY_EVENTS.includes(name)).sort(), IOS_ONLY_EVENTS);
  for (const name of new Set([...android, ...ios])) {
    assert.match(CONTROLLER, new RegExp(`\\b${name}: async function`), `controller handles ${name}`);
  }
  assert.deepEqual([...android].sort(), [
    'deepLink', 'insets', 'openSettings', 'pageFailed', 'pageLoaded', 'providerRedirect', 'providerSignInRequested',
    'pushTapped', 'refreshRequested', 'resume', 'webAuthClosed', 'webAuthReturned',
  ]);
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

test('the hosted-page script is injected at document start for the configured host only, or the local origin in bundled mode', () => {
  assert.match(ANDROID, /String origin = bundled \? localOrigin : "https:\/\/" \+ host;\s*WebViewCompat\.addDocumentStartJavaScript\(hosted, hostedScript, Collections\.singleton\(origin\)\)/);
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

test('the lock covers the hosted page when the app leaves the foreground, except during a prompt or web authentication', () => {
  assert.match(ANDROID, /handleOnPause\(\) \{\s*if \(lockEnabled\(\) && !authInProgress && !webAuthOpen\) \{\s*cover\(\);/);
  assert.match(IOS, /guard lockEnabled, !authInProgress, !webAuthOpen else \{ return \}\s*cover\(\)/);
});

// Provider sign-in (ADR 2026-10-16 v2, Ruling 6). Source checks only: they read the Swift and
// Java text and cannot show that ASWebAuthenticationSession, Custom Tabs, app-link
// verification or WebView interception behave this way on a device.

/** The text of one Java method or Swift function, from its signature to the next blank-line-free close. */
function body(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `source has ${signature}`);
  const end = source.indexOf('\n    }\n', start);
  return source.slice(start, end < 0 ? undefined : end);
}

test('iOS opens ASWebAuthenticationSession with an HTTPS callback for the configured host and exact exchange path', () => {
  assert.match(IOS, /^import AuthenticationServices$/m);
  const open = body(IOS, 'private func openWebAuth(');
  assert.match(open, /guard #available\(iOS 17\.4, \*\) else/);
  assert.match(open, /callbackHost == host/);
  assert.match(open, /callbackPath\.hasPrefix\("\/"\)/);
  assert.match(open, /url\.scheme == "https"/);
  assert.match(open, /ASWebAuthenticationSession\(url: url, callback: \.https\(host: callbackHost, path: callbackPath\)\)/);
  assert.match(open, /session\.prefersEphemeralWebBrowserSession = false/);
  assert.match(open, /session\.presentationContextProvider = self/);
  assert.doesNotMatch(open, /webView\?\.load|loadHTMLString/, 'the provider URL is not loaded in the WebView');
});

test('iOS reports support only on 17.4 or later and turns canceledLogin into a silent cancellation', () => {
  assert.match(body(IOS, 'private var providerSignInSupported: Bool'), /if #available\(iOS 17\.4, \*\) \{\s*return true\s*\}\s*return false/);
  assert.match(IOS, /"providerSignInSupported": providerSignInSupported/);
  const finish = body(IOS, 'private func finishWebAuth(');
  assert.match(finish, /emit\("webAuthReturned", \["url": callbackURL\.absoluteString, "leg": leg\]\)/);
  assert.match(finish, /\(error as\? ASWebAuthenticationSessionError\)\?\.code == \.canceledLogin/);
  assert.match(finish, /emit\("webAuthCancelled", \["leg": leg\]\)/);
  assert.match(finish, /emit\("webAuthFailed"/);
});

test('Android launches the provider URL in a Custom Tab, never in the WebView', () => {
  assert.match(ANDROID_GRADLE, /implementation "androidx\.browser:browser:\$androidxBrowserVersion"/);
  const open = body(ANDROID, 'private void openWebAuth(');
  assert.match(open, /new CustomTabsIntent\.Builder\(\)\.build\(\)\.launchUrl\(getActivity\(\), provider\)/);
  assert.match(open, /"https"\.equals\(provider\.getScheme\(\)\)/);
  assert.match(open, /host\.equals\(callbackHost\)/);
  assert.match(open, /catch \(ActivityNotFoundException error\)/);
  assert.doesNotMatch(open, /loadUrl/, 'the provider URL is not loaded in the WebView');
});

test('Android reports support only with a Custom Tabs provider and, on Android 12 or later, a verified host', () => {
  assert.match(ANDROID_MANIFEST, /<queries>\s*<intent>\s*<action android:name="android\.support\.customtabs\.action\.CustomTabsService" \/>/);
  const supported = body(ANDROID, 'private boolean providerSignInSupported()');
  assert.match(supported, /CustomTabsClient\.getPackageName\(getContext\(\), null\) == null\) \{\s*return false;/);
  assert.match(supported, /Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.S\) \{\s*return true;/);
  assert.match(supported, /getDomainVerificationUserState\(getContext\(\)\.getPackageName\(\)\)/);
  assert.match(supported, /getHostToStateMap\(\)\.get\(host\)/);
  assert.match(supported, /DomainVerificationUserState\.DOMAIN_STATE_VERIFIED/);
  assert.match(ANDROID, /put\(state, "providerSignInSupported", providerSignInSupported\(\)\)/);
});

test('both bootstraps cancel only the first pending main-frame off-host HTTPS navigation and report it', () => {
  assert.match(ANDROID_CLIENT, /shouldOverrideUrlLoading\(WebView view, WebResourceRequest request\) \{\s*if \(request\.isForMainFrame\(\) && listener\.onMainFrameNavigation\(request\.getUrl\(\)\)\) \{\s*return true;\s*\}\s*return super\.shouldOverrideUrlLoading\(view, request\);/);
  const android = body(ANDROID, 'public boolean onMainFrameNavigation(Uri url)');
  assert.match(android, /if \(signInLeg == 0 \|\| !"https"\.equals\(url\.getScheme\(\)\) \|\| host\.equals\(url\.getHost\(\)\)\) \{\s*return false;\s*\}/);
  assert.match(android, /int leg = signInLeg;\s*signInLeg = 0;/);
  assert.match(android, /emit\("providerRedirect", payload\);\s*return true;/);

  assert.match(IOS_PROXY, /decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping \(WKNavigationActionPolicy\) -> Void\) \{\s*if onNavigation\?\(navigationAction\) == true \{\s*decisionHandler\(\.cancel\)\s*return\s*\}/);
  assert.match(IOS_PROXY, /target\?\.webView\?\(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler\)/);
  const ios = body(IOS, 'private func interceptProviderRedirect(');
  assert.match(ios, /guard signInLeg != 0, action\.targetFrame\?\.isMainFrame == true, let url = action\.request\.url,\s*url\.scheme == "https", url\.host != host else \{\s*return false\s*\}/);
  assert.match(ios, /let leg = signInLeg\s*signInLeg = 0/);
  assert.match(ios, /emit\("providerRedirect", \["url": url\.absoluteString, "leg": leg\]\)\s*return true/);
});

test('the sign-in leg starts in the hosted WebView on the configured host only', () => {
  assert.match(body(ANDROID, 'private void startProviderSignIn('), /Uri target = hostUri\(path\);[\s\S]*signInLeg = leg;\s*hosted\.loadUrl\(target\.toString\(\)\);/);
  assert.match(body(IOS, 'private func startProviderSignIn('), /guard let url = hostURL\(path\) else[\s\S]*signInLeg = leg\s*bridge\?\.webView\?\.load\(URLRequest\(url: url\)\)/);
});

test('Android routes only the exact exchange path as a return and ignores callback-service links while a leg is open', () => {
  assert.match(ANDROID, /handleOnNewIntent\(Intent intent\) \{[\s\S]*?if \(!routeWebAuthReturn\(link\)\) \{\s*emit\("deepLink"/);
  const route = body(ANDROID, 'private boolean routeWebAuthReturn(Uri link)');
  assert.match(route, /if \(webAuthLeg == 0 \|\| !"https"\.equals\(link\.getScheme\(\)\) \|\| !host\.equals\(link\.getHost\(\)\)\) \{\s*return false;/);
  assert.match(route, /webAuthCallbackPath\.equals\(link\.getPath\(\)\)/);
  assert.match(route, /emit\("webAuthReturned", payload\);/);
  assert.match(route, /CALLBACK_SERVICE_PATH\.matcher\(path\)\.matches\(\)\) \{\s*Logger\.info\(TAG, "ignored an intermediate callback-service link during web authentication"\);\s*return true;/);
  assert.match(ANDROID, /Pattern\.compile\("\^\/api\/v1\/services\/\[0-9a-fA-F-\]\{36\}\/inbound\/\?\$"\)/);
  assert.match(body(ANDROID, 'protected void handleOnResume()'), /if \(webAuthOpen\) \{\s*webAuthOpen = false;\s*emit\("webAuthClosed", object\("leg", webAuthLeg\)\);/);
});

test('both bootstraps answer the hosted page capability and forward provider sign-in only while it is shown', () => {
  assert.match(ANDROID, /@PluginMethod\s*public void providerSignIn\(PluginCall call\) \{\s*String url = call\.getString\("url", ""\);\s*getActivity\(\)\.runOnUiThread\(\(\) -> \{\s*if \(hosted\.getVisibility\(\) == View\.VISIBLE\) \{\s*emit\("providerSignInRequested", object\("url", url\)\);/);
  assert.match(ANDROID, /@PluginMethod\s*public void capabilities\(PluginCall call\) \{\s*JSObject result = new JSObject\(\);\s*result\.put\("providerSignIn", providerSignInEnabled\);\s*call\.resolve\(result\);/);
  assert.match(IOS, /CAPPluginMethod\(name: "providerSignIn", returnType: CAPPluginReturnPromise\)/);
  assert.match(IOS, /CAPPluginMethod\(name: "capabilities", returnType: CAPPluginReturnPromise\)/);
  assert.match(IOS, /guard let self = self, self\.bridge\?\.webView\?\.scrollView\.isHidden == false else \{ return \}\s*self\.emit\("providerSignInRequested", \["url": url\]\)/);
  assert.match(IOS, /call\.resolve\(\["providerSignIn": providerSignInEnabled\]\)/);
  for (const source of [ANDROID, IOS]) {
    assert.match(source, /window\.MeroFoundryShell&&window\.MeroFoundryShell\._setProviderSignIn\(/);
  }
});

test('host fetches stay on the configured https host and follow no redirects', () => {
  assert.match(body(ANDROID, 'private void fetchHost('), /Uri target = hostUri\(path\);\s*if \(target == null\) \{\s*replyError\(id, "refused to load a URL outside the application host"\);/);
  assert.match(body(ANDROID, 'private void fetchHost('), /setInstanceFollowRedirects\(false\)/);
  assert.match(body(ANDROID, 'private void fetchHost('), /setUseCaches\(false\)/);
  assert.match(IOS, /willPerformHTTPRedirection[\s\S]*?completionHandler\(nil\)/);
  assert.match(body(IOS, 'private func fetchHost('), /guard let url = hostURL\(path\) else/);
  assert.match(body(IOS, 'private func fetchHost('), /URLSession\(configuration: \.ephemeral, delegate: ShellNoRedirects\(\)/);
});

// Relocated shell assets, mode and host (C.12-C.14). Source checks only: they read the Swift and
// Java text and the files the assembler produces; no WebView, Keychain or Keystore runs here.

const { MANIFEST, prepareWeb } = require('../lib/web-assets.cjs');
const { BUNDLED_PAGES } = require('../lib/ios-project.cjs');
const { tempDir } = require('./helpers/temp.cjs');

/** Every packaged asset path the native sources name, as paths under the platform's public/ directory. */
function nativeAssetPaths() {
  const android = [...ANDROID.matchAll(/"public\/([\w./-]+)"/g), ...ANDROID_OVERLAY.matchAll(/\/assets\/public\/([\w./-]+)"/g)].map((m) => m[1]);
  const ios = [...[IOS, IOS_OVERLAY].join('\n').matchAll(/forResource: "([\w-]+)", withExtension: "(\w+)", subdirectory: "public\/([\w/]+)"/g)]
    .map((m) => `${m[3]}/${m[1]}.${m[2]}`);
  return { android, ios };
}

test('both overlays load public/meroshell/index.html and both loaders inject public/meroshell/hosted-integration.js', () => {
  const { android, ios } = nativeAssetPaths();
  const expected = ['meroshell/bearer-client.js', 'meroshell/hosted-integration.js', 'meroshell/index.html'];
  assert.deepEqual(android.sort(), expected);
  assert.deepEqual(ios.sort(), expected);
  assert.match(ANDROID_OVERLAY, /INDEX_URL = "https:\/\/" \+ ASSET_HOST \+ "\/assets\/public\/meroshell\/index\.html"/);
  assert.match(ANDROID, /HOSTED_INTEGRATION_ASSET = "public\/meroshell\/hosted-integration\.js"/);
  assert.match(IOS_OVERLAY, /Bundle\.main\.url\(forResource: "index", withExtension: "html", subdirectory: "public\/meroshell"\)/);
  assert.match(IOS, /Bundle\.main\.url\(forResource: "hosted-integration", withExtension: "js", subdirectory: "public\/meroshell"\)/);
  assert.deepEqual([...BUNDLED_PAGES].sort(), expected);
  for (const source of [...NATIVE_SOURCES.android, ...NATIVE_SOURCES.ios]) {
    assert.doesNotMatch(source, /"public\/(index\.html|hosted-integration\.js)"|subdirectory: "public"\)/, 'no native code reads the old asset locations');
  }
});

test('every native asset path exists in the assembled www of both modes', () => {
  const { android, ios } = nativeAssetPaths();
  for (const mode of ['remote', 'bundled']) {
    const dir = tempDir('meroshell-native-assets-');
    fs.cpSync(path.join(__dirname, '..', 'shell'), path.join(dir, 'shell'), { recursive: true });
    const starter = { host: 'shop.example.com', appId: 'com.example.shop', appName: 'Shop', mode };
    if (mode === 'bundled') {
      starter.site = 'site';
      fs.mkdirSync(path.join(dir, 'site'));
      fs.writeFileSync(path.join(dir, 'site', 'index.html'), '<!doctype html><title>Shop</title>');
    }
    fs.writeFileSync(path.join(dir, 'starter.config.json'), JSON.stringify(starter));
    prepareWeb({ rootDir: dir });
    for (const asset of new Set([...android, ...ios, ...BUNDLED_PAGES, MANIFEST])) {
      assert.ok(fs.existsSync(path.join(dir, 'www', asset)), `${mode}: www/${asset}`);
    }
    assert.equal(fs.existsSync(path.join(dir, 'www', 'index.html')), mode === 'bundled', `${mode}: site index at the www root`);
  }
});

test('the iOS overlay may read only its own meroshell directory', () => {
  const load = body(IOS_OVERLAY, 'func load()');
  assert.match(load, /root = index\.deletingLastPathComponent\(\)/);
  assert.match(load, /webView\.loadFileURL\(index, allowingReadAccessTo: index\.deletingLastPathComponent\(\)\)/);
});

test('both bootstraps read host and mode from the MeroShell plugin configuration, never from server.url', () => {
  assert.match(body(ANDROID, 'public void load()'), /host = getConfig\(\)\.getString\("host", ""\);\s*bundled = "bundled"\.equals\(getConfig\(\)\.getString\("mode", "remote"\)\);/);
  assert.match(body(IOS, 'override public func load()'), /host = getConfig\(\)\.getString\("host", ""\) \?\? ""\s*bundled = getConfig\(\)\.getString\("mode", "remote"\) == "bundled"/);
  assert.doesNotMatch(ANDROID, /getServerUrl\(\)/);
  assert.doesNotMatch(IOS, /serverURL/);
});

test('bridge initialization permits the bundled local origin and keeps the remote host rule', () => {
  const androidLoad = body(ANDROID, 'public void load()');
  assert.match(androidLoad, /localOrigin = bundled \? getBridge\(\)\.getLocalUrl\(\) : null;/);
  const androidInject = body(ANDROID, 'private void injectHostedIntegration()');
  assert.match(androidInject, /put\(config, "mode", bundled \? "bundled" : "remote"\);/);
  assert.match(androidInject, /put\(config, "localOrigin", localOrigin == null \? "" : localOrigin\);/);
  assert.match(androidInject, /String origin = bundled \? localOrigin : "https:\/\/" \+ host;/);
  assert.match(androidInject, /addDocumentStartJavaScript\(hosted, hostedScript, Collections\.singleton\(origin\)\)/);

  assert.match(body(IOS, 'override public func load()'), /localOrigin = bundled \? \(bridge\?\.config\.localURL\.absoluteString \?\? ""\) : ""/);
  const iosInject = body(IOS, 'private func injectHostedIntegration(');
  assert.match(iosInject, /"mode": bundled \? "bundled" : "remote"/);
  assert.match(iosInject, /"localOrigin": localOrigin/);
});

test('page loads go to the local origin in bundled mode and to the application host in remote mode', () => {
  const android = body(ANDROID, 'private Uri pageUri(String path)');
  assert.match(android, /Uri base = Uri\.parse\(bundled \? localOrigin : "https:\/\/" \+ host\);/);
  assert.match(android, /!path\.startsWith\("\/"\) \|\| !base\.getScheme\(\)\.equals\(target\.getScheme\(\)\) \|\| !base\.getHost\(\)\.equals\(target\.getHost\(\)\)/);
  assert.match(body(ANDROID, 'private void loadHost('), /Uri target = pageUri\(path\);/);
  const ios = body(IOS, 'private func pageURL(');
  assert.match(ios, /let base = bundled \? localOrigin : "https:\/\/\\\(host\)"/);
  assert.match(ios, /url\.scheme == URL\(string: base\)\?\.scheme, url\.host == URL\(string: base\)\?\.host/);
  assert.match(body(IOS, 'private func loadHost('), /guard let url = pageURL\(path\) else/);
});

// Secure session storage. Source verification only: no Keychain or Android Keystore runs here.

test('both bootstraps expose loadSession, saveSession and clearSession to the page', () => {
  for (const method of ['loadSession', 'saveSession', 'clearSession']) {
    assert.match(ANDROID, new RegExp(`@PluginMethod\\s*public void ${method}\\(PluginCall call\\)`), `android ${method}`);
    assert.match(IOS, new RegExp(`CAPPluginMethod\\(name: "${method}", returnType: CAPPluginReturnPromise\\)`), `ios ${method}`);
    assert.match(IOS, new RegExp(`@objc func ${method}\\(_ call: CAPPluginCall\\)`), `ios ${method}`);
  }
  const HOSTED = fs.readFileSync(path.join(__dirname, '..', 'shell', 'hosted-integration.js'), 'utf8');
  for (const method of ['loadSession', 'saveSession', 'clearSession']) {
    assert.match(HOSTED, new RegExp(`nativeCall\\('MeroShell', '${method}'`));
  }
});

test('iOS keeps the pair in the Keychain under the app id, this device only, after first unlock', () => {
  assert.match(IOS_STORE, /^import Security$/m);
  assert.match(IOS_STORE, /kSecClass as String: kSecClassGenericPassword/);
  assert.match(IOS_STORE, /kSecAttrService as String: service/);
  assert.match(IOS_STORE, /kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
  for (const call of ['SecItemAdd', 'SecItemCopyMatching', 'SecItemDelete']) {
    assert.match(IOS_STORE, new RegExp(`${call}\\(`), call);
  }
  assert.match(IOS_STORE, /errSecItemNotFound/);
  assert.match(IOS, /ShellSessionStore\(service: getConfig\(\)\.getString\("appId", ""\) \?\? ""\)/);
});

test('Android keeps the pair in EncryptedSharedPreferences under a Keystore master key', () => {
  assert.match(ANDROID_GRADLE, /implementation "androidx\.security:security-crypto:\$androidxSecurityCryptoVersion"/);
  assert.match(ANDROID_GRADLE, /androidxSecurityCryptoVersion = [^\n]*'1\.1\.0'/);
  assert.match(ANDROID_STORE, /new MasterKey\.Builder\(context\)\s*\.setKeyScheme\(MasterKey\.KeyScheme\.AES256_GCM\)/);
  assert.match(ANDROID_STORE, /EncryptedSharedPreferences\.create\(\s*context,\s*FILE,\s*masterKey,\s*EncryptedSharedPreferences\.PrefKeyEncryptionScheme\.AES256_SIV,\s*EncryptedSharedPreferences\.PrefValueEncryptionScheme\.AES256_GCM/);
  assert.doesNotMatch(ANDROID_STORE, /getSharedPreferences\(/, 'never a plain SharedPreferences file');
  assert.match(ANDROID, /new ShellSessionStore\(getContext\(\)\)/);
});

test('session tokens never reach a log, an event, the overlay or the settings screens', () => {
  const tokenish = /token/i;
  for (const [platform, sources] of Object.entries(NATIVE_SOURCES)) {
    for (const source of sources) {
      for (const line of source.split('\n')) {
        if (/Logger\.|CAPLog\.|NSLog\(|\bprint\(|Log\.[dviwe]\(/.test(line)) {
          assert.doesNotMatch(line, tokenish, `${platform} logs no token: ${line.trim()}`);
        }
        if (/emit\(|reply\(|replyError\(|overlay\.send\(/.test(line)) {
          assert.doesNotMatch(line, tokenish, `${platform} sends no token to the overlay: ${line.trim()}`);
        }
      }
    }
  }
  for (const method of ['loadSession', 'saveSession', 'clearSession']) {
    for (const text of [body(ANDROID, `public void ${method}(PluginCall call)`), body(IOS, `@objc func ${method}(_ call: CAPPluginCall)`)]) {
      assert.doesNotMatch(text, /emit\(|Logger\.|CAPLog\.|print\(|evaluateJavascript|evaluateJavaScript/, method);
    }
  }
  for (const file of ['index.html', 'controller.js', 'view.js', 'main.js', 'channel.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'shell', file), 'utf8');
    assert.doesNotMatch(text, /accessToken|refreshToken|loadSession|saveSession|clearSession/, `${file} never handles the session`);
  }
});

test('secure-store failures reject with fixed messages that carry no token', () => {
  for (const [platform, source] of [['android', ANDROID], ['ios', IOS]]) {
    const rejections = [...source.matchAll(/call\.reject\(([^)]*)\)/g)].map((m) => m[1]);
    assert.ok(rejections.length >= 3, `${platform} rejects session failures`);
    for (const rejection of rejections) {
      assert.match(rejection, /^"[^"]+"$/, `${platform} rejection is a literal: ${rejection}`);
    }
  }
});

// Bundled provider completion, settings sign-out and the bearer client (C.15-C.18). Source checks
// only: they read the Swift and Java text. No WKWebView, Android WebView, Keychain or Keystore
// runs here, so none of this is evidence of device behaviour.

/** A Java or Swift source without its comment lines. */
const code = (source) => source.split('\n').filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join('\n');

test('both loaders inject bearer-client.js immediately before hosted-integration.js', () => {
  assert.match(ANDROID, /HOSTED_BEARER_ASSET = "public\/meroshell\/bearer-client\.js"/);
  assert.match(body(ANDROID, 'private void injectHostedIntegration()'), /hostedScript = "window\.__meroShellConfig=" \+ config \+ ";\\n" \+ bearer \+ "\\n" \+ source;/);
  assert.match(IOS, /Bundle\.main\.url\(forResource: "bearer-client", withExtension: "js", subdirectory: "public\/meroshell"\)/);
  assert.match(body(IOS, 'private func injectHostedIntegration('), /let script = "window\.__meroShellConfig=\\\(Self\.json\(config\) \?\? "null"\);\\n\\\(bearer\)\\n\\\(source\)"/);
});

test('both bootstraps report the local origin in launch state', () => {
  assert.match(ANDROID, /put\(state, "localOrigin", localOrigin == null \? "" : localOrigin\);/);
  assert.match(IOS, /"localOrigin": localOrigin,/);
});

test('the exchange is accepted only in bundled mode, on the host, at an exchange path with session=bearer', () => {
  const android = body(ANDROID, 'private Uri exchangeUri(String path)');
  assert.match(android, /Uri target = hostUri\(path\);/);
  assert.match(android, /EXCHANGE_PATH\.matcher\(target\.getPath\(\)\)\.matches\(\)/);
  assert.match(android, /List<String> session = target\.getQueryParameters\("session"\);\s*return session\.size\(\) == 1 && "bearer"\.equals\(session\.get\(0\)\) \? target : null;/);
  assert.match(body(ANDROID, 'private void exchangeSession('), /if \(!bundled \|\| target == null\) \{\s*replyError\(id, "refused to exchange outside the application exchange route"\);/);
  const ios = body(IOS, 'private func exchangeURL(');
  assert.match(ios, /guard let url = hostURL\(path\), url\.path\.range\(of: Self\.exchangePath, options: \.regularExpression\) != nil/);
  assert.match(ios, /items\.filter\(\{ \$0\.name == "session" \}\)\.map\(\{ \$0\.value \}\) == \["bearer"\]/);
  assert.match(body(IOS, 'private func exchangeSession('), /guard bundled, let url = exchangeURL\(path\), let hosted = bridge\?\.webView, let store = sessionStore else \{\s*replyError\(id, "refused to exchange outside the application exchange route"\)/);
  const uuidPath = '\\^/api/v1/applications/\\[0-9a-f\\]\\{8\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{12\\}/auth/oauth/exchange\\$';
  assert.match(ANDROID, new RegExp(`EXCHANGE_PATH = Pattern\\.compile\\("${uuidPath}"\\)`));
  assert.match(IOS, new RegExp(`exchangePath = "${uuidPath}"`));
});

test('iOS captures the exchange answer in a web view on the hosted web view data store, not a URLSession', () => {
  const init = body(IOS_EXCHANGE, 'init(url: URL, sharing hosted: WKWebView');
  assert.match(init, /configuration\.websiteDataStore = hosted\.configuration\.websiteDataStore/);
  assert.match(init, /configuration\.processPool = hosted\.configuration\.processPool/);
  assert.match(init, /webView = WKWebView\(frame: \.zero, configuration: configuration\)/);
  assert.doesNotMatch(code(IOS_EXCHANGE), /URLSession|ShellNoRedirects|ephemeral/, 'not the fetchHost networking context');
  assert.match(body(IOS, 'private func exchangeSession('), /ShellSessionExchange\(url: url, sharing: hosted\)/);
});

test('iOS loads only the exact exchange URL and reads only a 200 application/json answer', () => {
  const action = body(IOS_EXCHANGE, 'decidePolicyFor navigationAction');
  assert.match(action, /guard navigationAction\.targetFrame\?\.isMainFrame == true, navigationAction\.request\.url == url else \{\s*decisionHandler\(\.cancel\)\s*finish\(\.refused\)/);
  const response = body(IOS_EXCHANGE, 'decidePolicyFor navigationResponse');
  assert.match(response, /response\.statusCode == 200 else \{\s*decisionHandler\(\.cancel\)\s*finish\(\.refused\)/);
  assert.match(response, /guard response\.mimeType == "application\/json" else \{\s*decisionHandler\(\.cancel\)\s*finish\(\.malformed\)/);
  assert.match(IOS_EXCHANGE, /private static let readBody = "document\.body \? document\.body\.textContent : ''"/);
  const outcome = body(IOS_EXCHANGE, 'static func outcome(from text: String?)');
  assert.match(outcome, /let access = body\["accessToken"\] as\? String, !access\.isEmpty/);
  assert.match(outcome, /let refresh = body\["refreshToken"\] as\? String, !refresh\.isEmpty/);
  assert.match(outcome, /let returnTo = body\["returnTo"\] as\? String else \{\s*return \.malformed/);
  assert.match(body(IOS_EXCHANGE, 'private static func failure('), /domain == NSURLErrorDomain \? \.unreachable : \.refused/);
  assert.match(body(IOS_EXCHANGE, 'private func finish('), /guard let completion = completion else \{ return \}\s*self\.completion = nil/);
});

test('Android captures the exchange answer in a WebView sharing the CookieManager, not an HttpURLConnection', () => {
  assert.match(ANDROID_EXCHANGE, /webView = new WebView\(context\);/);
  assert.match(ANDROID_EXCHANGE, /webView\.setWebViewClient\(new ExchangeClient\(\)\);/);
  assert.match(ANDROID_EXCHANGE, /webView\.loadUrl\(url\.toString\(\)\);/);
  assert.doesNotMatch(code(ANDROID_EXCHANGE), /HttpURLConnection|openConnection/, 'not the fetchHost networking context');
  assert.match(body(ANDROID, 'private void exchangeSession('), /new ShellSessionExchange\(getContext\(\), target, outcome -> \{/);
});

test('Android loads only the exact exchange URL and refuses redirects and HTTP errors', () => {
  assert.match(body(ANDROID_EXCHANGE, 'public boolean shouldOverrideUrlLoading('), /if \(request\.isForMainFrame\(\) && url\.equals\(request\.getUrl\(\)\)\) \{\s*return false;\s*\}\s*failed = true;\s*finish\(Outcome\.of\(REFUSED\)\);\s*return true;/);
  assert.match(body(ANDROID_EXCHANGE, 'public void onReceivedHttpError('), /if \(request\.isForMainFrame\(\)\) \{\s*failed = true;\s*finish\(Outcome\.of\(REFUSED\)\);/);
  assert.match(body(ANDROID_EXCHANGE, 'public void onReceivedError('), /if \(request\.isForMainFrame\(\)\) \{\s*failed = true;\s*finish\(Outcome\.of\(UNREACHABLE\)\);/);
  assert.match(body(ANDROID_EXCHANGE, 'public void onPageFinished('), /view\.evaluateJavascript\(READ_BODY, evaluated -> finish\(outcome\(evaluated\)\)\);/);
  const outcome = body(ANDROID_EXCHANGE, 'static Outcome outcome(String evaluated)');
  assert.match(outcome, /if \(!\(text instanceof String\)\) \{\s*return Outcome\.of\(MALFORMED\);/);
  assert.match(outcome, /if \(access\.isEmpty\(\) \|\| refresh\.isEmpty\(\) \|\| !\(returnTo instanceof String\)\) \{\s*return Outcome\.of\(MALFORMED\);/);
  assert.match(outcome, /catch \(JSONException error\) \{\s*return Outcome\.of\(MALFORMED\);/);
  assert.match(body(ANDROID_EXCHANGE, 'private void finish('), /if \(current == null\) \{\s*return;\s*\}\s*callback = null;/);
});

test('a signed-in exchange is saved in secure storage before a token-free reply; failures reply a fixed status', () => {
  const android = body(ANDROID, 'private void finishExchange(');
  assert.match(android, /if \(!ShellSessionExchange\.SIGNED_IN\.equals\(outcome\.status\)\) \{\s*reply\(id, object\("status", outcome\.status\)\);\s*return;/);
  assert.match(android, /sessionStore\.save\(outcome\.accessToken, outcome\.refreshToken\);\s*\} catch \(GeneralSecurityException \| IOException error\) \{\s*reply\(id, object\("status", "storageFailed"\)\);/);
  assert.match(android, /JSONObject result = object\("status", ShellSessionExchange\.SIGNED_IN\);\s*put\(result, "returnTo", outcome\.returnTo\);\s*reply\(id, result\);/);
  const ios = body(IOS, 'private func finishExchange(');
  assert.match(ios, /case \.signedIn\(let pair, let returnTo\):\s*do \{\s*try store\.save\(pair\)\s*\} catch \{\s*reply\(id, \["status": "storageFailed"\]\)\s*return\s*\}\s*reply\(id, \["status": "signedIn", "returnTo": returnTo\]\)/);
  for (const status of ['refused', 'malformed', 'unreachable', 'cancelled']) {
    assert.match(ios, new RegExp(`reply\\(id, \\["status": "${status}"\\]\\)`), status);
    assert.match(ANDROID_EXCHANGE, new RegExp(`= "${status}";`), status);
  }
  for (const text of [android, ios]) {
    assert.doesNotMatch(text, /reply\([^\n]*(accessToken|refreshToken|pair)/, 'no token in a reply');
  }
});

test('a cancelled sign-in leg also cancels an exchange in flight on both platforms', () => {
  assert.match(ANDROID, /case "cancelProviderSignIn":[\s\S]*?if \(sessionExchange != null\) \{\s*sessionExchange\.cancel\(\);\s*\}\s*reply\(id, null\);/);
  assert.match(IOS, /case "cancelProviderSignIn":[\s\S]*?sessionExchange\?\.cancel\(\)\s*reply\(id, nil\)/);
});

test('sessionChanged reaches the page through _sessionChanged with only the signed-in flag', () => {
  assert.match(ANDROID, /case "sessionChanged":\s*boolean signedIn = args\.optBoolean\("signedIn"\);\s*hosted\.evaluateJavascript\("window\.MeroFoundryShell&&window\.MeroFoundryShell\._sessionChanged\(\{signedIn:" \+ signedIn \+ "\}\)", null\);/);
  assert.match(IOS, /case "sessionChanged":\s*let signedIn = args\["signedIn"\] as\? Bool \?\? false\s*bridge\?\.webView\?\.evaluateJavaScript\("window\.MeroFoundryShell&&window\.MeroFoundryShell\._sessionChanged\(\{signedIn:\\\(signedIn\)\}\)"\)/);
});

test('bundled sign-out clears the saved pair with a fixed failure message', () => {
  assert.match(body(ANDROID, 'private void clearSavedSession('), /sessionStore\.clear\(\);\s*\} catch \(GeneralSecurityException \| IOException error\) \{\s*replyError\(id, "secure session storage is unavailable"\);/);
  assert.match(body(IOS, 'private func clearSavedSession('), /try sessionStore\?\.clear\(\)\s*reply\(id, nil\)\s*\} catch \{\s*replyError\(id, "secure session storage is unavailable"\)/);
});

// Native push (D.13-D.17). Source checks only: they read the Swift, Java, manifest and Gradle
// text. No APNs, FCM, UNUserNotificationCenter, notification permission or device runs here, and
// nothing is compiled, so none of this is evidence of device behaviour.

const IOS_PUSH_CODE = code(IOS_PUSH);
const ANDROID_PUSH_CODE = code(ANDROID_PUSH);
const APP_GRADLE = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'build.gradle'), 'utf8');

test('both bootstraps expose registerPush, unregisterPush, getPushState and pushDisabled to the page', () => {
  const HOSTED = fs.readFileSync(path.join(__dirname, '..', 'shell', 'hosted-integration.js'), 'utf8');
  for (const method of ['registerPush', 'unregisterPush', 'getPushState', 'pushDisabled']) {
    assert.match(ANDROID, new RegExp(`@PluginMethod\\s*public void ${method}\\(PluginCall call\\)`), `android ${method}`);
    assert.match(IOS, new RegExp(`CAPPluginMethod\\(name: "${method}", returnType: CAPPluginReturnPromise\\)`), `ios ${method}`);
    assert.match(IOS, new RegExp(`@objc func ${method}\\(_ call: CAPPluginCall\\)`), `ios ${method}`);
  }
  assert.match(HOSTED, /nativeCall\('MeroShell', method, options\)/);
  assert.match(HOSTED, /nativeCall\('MeroShell', 'pushDisabled', \{ ok: ok \}\)/);
  for (const method of ['registerPush', 'unregisterPush', 'getPushState']) {
    assert.match(HOSTED, new RegExp(`ports\\.native\\('${method}'\\)`), method);
  }
});

test('registerPush answers granted with token and platform, denied, or unavailable with a reason', () => {
  const ios = body(IOS, '@objc func registerPush(');
  assert.match(ios, /case \.granted\(let value\):\s*call\.resolve\(\["status": "granted", "token": value, "platform": "apns"\]\)/);
  assert.match(ios, /case \.denied:\s*call\.resolve\(\["status": "denied"\]\)/);
  assert.match(ios, /case \.unavailable\(let reason\):\s*call\.resolve\(\["status": "unavailable", "reason": reason\]\)/);
  const android = body(ANDROID, 'private void acquirePushRegistration(');
  assert.match(android, /JSObject result = pushOutcome\("granted", null\);\s*result\.put\("token", registration\);\s*result\.put\("platform", ShellPush\.PLATFORM\);\s*call\.resolve\(result\);/);
  assert.match(android, /call\.resolve\(pushOutcome\("unavailable", reason\)\);/);
  assert.match(android, /areNotificationsEnabled\(\)\) \{\s*call\.resolve\(pushOutcome\("denied", null\)\);/);
  assert.match(ANDROID_PUSH, /static final String PLATFORM = "fcm";/);
});

test('permission is asked only while undetermined, only by registerPush, and getPushState never prompts', () => {
  const register = body(IOS_PUSH, 'func register(');
  assert.match(register, /case \.denied:\s*completion\(\.denied\)/);
  assert.match(register, /case \.notDetermined:\s*center\.requestAuthorization\(options: \[\.alert, \.sound, \.badge\]\)/);
  assert.equal((IOS_PUSH_CODE.match(/requestAuthorization\(/g) || []).length, 1, 'iOS asks in one place');
  assert.doesNotMatch(body(IOS_PUSH, 'func state('), /requestAuthorization/);
  assert.match(body(IOS_PUSH, 'func state('), /case \.denied:\s*permission = "denied"\s*case \.notDetermined:\s*permission = "prompt"/);

  const android = body(ANDROID, 'public void registerPush(PluginCall call)');
  assert.match(android, /if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.TIRAMISU\) \{\s*PermissionState permission = getPermissionState\(ShellPush\.PERMISSION\);\s*if \(permission == PermissionState\.DENIED\) \{\s*call\.resolve\(pushOutcome\("denied", null\)\);\s*return;\s*\}\s*if \(permission != PermissionState\.GRANTED\) \{\s*requestPermissionForAlias\(ShellPush\.PERMISSION, call, "pushPermissionAnswered"\);/);
  assert.equal((code(ANDROID).match(/requestPermissionForAlias\(/g) || []).length, 1, 'Android asks in one place');
  assert.match(ANDROID, /@PermissionCallback\s*private void pushPermissionAnswered\(PluginCall call\) \{\s*if \(getPermissionState\(ShellPush\.PERMISSION\) == PermissionState\.GRANTED\) \{\s*acquirePushRegistration\(call\);\s*\} else \{\s*call\.resolve\(pushOutcome\("denied", null\)\);/);
  assert.doesNotMatch(body(ANDROID, 'public void getPushState(PluginCall call)'), /requestPermission/);
  assert.doesNotMatch(body(ANDROID, 'private String pushPermission()'), /requestPermission/);
  assert.match(ANDROID, /permissions = \{ @Permission\(strings = \{ Manifest\.permission\.POST_NOTIFICATIONS \}, alias = ShellPush\.PERMISSION\) \}/);
  assert.match(ANDROID_MANIFEST, /<uses-permission android:name="android\.permission\.POST_NOTIFICATIONS" \/>/);
});

test('the enabled flag and last token persist beside the saved session on both platforms', () => {
  assert.match(IOS_STORE, /private static let pushAccount = "push"/);
  assert.match(IOS_STORE, /func loadPush\(\) throws -> PushState\? \{\s*try read\(Self\.pushAccount, as: PushState\.self\)/);
  assert.match(IOS_STORE, /func savePush\(_ state: PushState\) throws \{\s*try write\(Self\.pushAccount/);
  assert.match(IOS_STORE, /func clear\(\) throws \{\s*let status = SecItemDelete\(item\(Self\.account\) as CFDictionary\)/, 'clearing the session keeps push');
  assert.match(body(IOS_PUSH, 'private func finishRegistration('), /try store\?\.savePush\(ShellSessionStore\.PushState\(enabled: true, token: token\)\)\s*\} catch \{\s*answer\(\.unavailable\("storage"\)\)/);
  assert.match(body(IOS_PUSH, 'func unregister()'), /try store\?\.savePush\(ShellSessionStore\.PushState\(enabled: false, token: nil\)\)/);
  assert.match(IOS, /let push = ShellPush\(store: sessionStore\)/);

  assert.match(ANDROID_STORE, /PUSH_ENABLED = "pushEnabled";/);
  assert.match(ANDROID_STORE, /PUSH_TOKEN = "pushToken";/);
  assert.match(body(ANDROID_STORE, 'synchronized void savePush('), /preferences\(\)\.edit\(\)\.putBoolean\(PUSH_ENABLED, enabled\)/);
  assert.match(body(ANDROID_STORE, 'synchronized void clear()'), /preferences\(\)\.edit\(\)\.remove\(ACCESS_TOKEN\)\.remove\(REFRESH_TOKEN\)\.commit\(\)/, 'clearing the session keeps push');
  assert.match(body(ANDROID, 'private void acquirePushRegistration('), /sessionStore\.savePush\(true, registration\);/);
  assert.match(body(ANDROID, 'private String forgetPush()'), /sessionStore\.savePush\(false, null\);/);
});

test('unregisterPush performs the platform unregister or delete and answers the token it held', () => {
  const ios = body(IOS_PUSH, 'func unregister()');
  assert.match(ios, /UIApplication\.shared\.unregisterForRemoteNotifications\(\)/);
  assert.match(ios, /let previous = stored\(\)\?\.token[\s\S]*return previous/);
  assert.match(body(IOS, '@objc func unregisterPush('), /call\.resolve\(\["status": "unregistered", "token": \(previous as Any\?\) \?\? NSNull\(\)\]\)/);
  assert.match(ANDROID_PUSH, /static void deleteToken\(\) \{\s*FirebaseMessaging\.getInstance\(\)\.deleteToken\(\);/);
  assert.match(body(ANDROID, 'private String forgetPush()'), /if \(pushAvailable\) \{\s*ShellPush\.deleteToken\(\);\s*\}\s*return previous;/);
  assert.match(body(ANDROID, 'public void unregisterPush(PluginCall call)'), /result\.put\("token", previous == null \? JSONObject\.NULL : previous\);/);
});

test('iOS installs the notification delegate during load and takes the APNs token from the Capacitor AppDelegate notifications', () => {
  const load = body(IOS, 'override public func load()');
  assert.ok(load.indexOf('installPush()') >= 0 && load.indexOf('installPush()') < load.indexOf('guard let hosted'), 'installed before any early return');
  assert.match(body(IOS, 'private func installPush()'), /push\.install\(\)/);
  const install = body(IOS_PUSH, 'func install()');
  assert.match(install, /UNUserNotificationCenter\.current\(\)\.delegate = self/);
  assert.match(install, /name: \.capacitorDidRegisterForRemoteNotifications/);
  assert.match(install, /name: \.capacitorDidFailToRegisterForRemoteNotifications/);
  assert.match(IOS_PUSH, /final class ShellPush: NSObject, UNUserNotificationCenterDelegate/);
  assert.match(body(IOS_PUSH, '@objc private func didRegister('), /guard let deviceToken = notification\.object as\? Data else \{ return \}\s*let token = Self\.hex\(deviceToken\)/);
  assert.match(IOS_PUSH, /deviceToken\.map \{ String\(format: "%02x", \$0\) \}\.joined\(\)/);
  assert.match(body(IOS_PUSH, 'private func requestToken('), /UIApplication\.shared\.registerForRemoteNotifications\(\)/);
  assert.match(body(IOS_PUSH, 'private func requestToken('), /self\.answer\(\.unavailable\("registration_timeout"\)\)/);
  assert.match(body(IOS_PUSH, '@objc private func didFailToRegister('), /answer\(\.unavailable\("registration_failed"\)\)/);
});

test('iOS shows foreground notifications as banners and reports a tap with its path', () => {
  assert.match(body(IOS_PUSH, 'willPresent notification: UNNotification'), /completionHandler\(\[\.banner, \.list, \.sound, \.badge\]\)/);
  const tap = body(IOS_PUSH, 'didReceive response: UNNotificationResponse');
  assert.match(tap, /response\.actionIdentifier == UNNotificationDefaultActionIdentifier/);
  assert.match(tap, /let path = Self\.tapPath\(response\.notification\.request\.content\.userInfo\)/);
  assert.match(tap, /self\.onTap\?\(path\)/);
  assert.match(tap, /completionHandler\(\)/);
  assert.match(body(IOS_PUSH, 'static func tapPath('), /guard let value = userInfo\["path"\] else \{ return "" \}/);
  assert.match(IOS, /push\.onTap = \{ \[weak self\] path in self\?\.emit\("pushTapped", \["path": path\]\) \}/);
});

test('a changed iOS token is reported only while push is on, through the same page path', () => {
  const refresh = body(IOS_PUSH, 'private func finishRegistration(');
  assert.match(refresh, /guard !waiting\.isEmpty else \{[\s\S]*?guard let state = stored\(\), state\.enabled, state\.token != token else \{ return \}[\s\S]*?onToken\?\(token\)/);
  assert.match(body(IOS_PUSH, 'func install()'), /if enabled \{\s*UIApplication\.shared\.registerForRemoteNotifications\(\)/);
  assert.match(body(IOS, 'private func deliverPushToken('), /evaluateJavaScript\("window\.MeroFoundryShell&&window\.MeroFoundryShell\._pushToken\(\\\(payload\)\)"\)/);
});

test('Android declares the messaging service, the Firebase Messaging dependency and token refresh', () => {
  assert.match(ANDROID_GRADLE, /firebaseMessagingVersion = [^\n]*'25\.0\.1'/);
  assert.match(ANDROID_GRADLE, /implementation "com\.google\.firebase:firebase-messaging:\$firebaseMessagingVersion"/);
  assert.match(ANDROID_MESSAGING, /public class MeroShellMessagingService extends FirebaseMessagingService/);
  assert.match(ANDROID_MESSAGING, /public void onNewToken\(@NonNull String refreshed\) \{\s*ShellPush\.tokenRefreshed\(refreshed\);/);
  assert.match(ANDROID_MESSAGING, /public void onMessageReceived\(@NonNull RemoteMessage message\) \{\s*ShellPush\.showForeground\(getApplicationContext\(\), message\);/);
  assert.match(ANDROID_MANIFEST, /<service\s+android:name="app\.merofoundry\.shell\.MeroShellMessagingService"\s+android:exported="false">\s*<intent-filter>\s*<action android:name="com\.google\.firebase\.MESSAGING_EVENT" \/>/);
  assert.match(body(ANDROID_PUSH, 'static void requestToken('), /FirebaseMessaging\.getInstance\(\)\.getToken\(\)\.addOnCompleteListener/);
  assert.match(body(ANDROID, 'private void deliverPushToken('), /if \(!sessionStore\.pushEnabled\(\)\) \{\s*return;\s*\}/);
  assert.match(body(ANDROID, 'private void deliverPushToken('), /hosted\.evaluateJavascript\("window\.MeroFoundryShell&&window\.MeroFoundryShell\._pushToken\(" \+ payload \+ "\)", null\);/);
});

test('Android with google-services.json: registration, refresh and deletion go through FirebaseMessaging', () => {
  assert.match(body(ANDROID, 'public void load()'), /pushAvailable = ShellPush\.available\(getContext\(\)\);\s*if \(pushAvailable\) \{\s*ShellPush\.listen\(/);
  assert.match(body(ANDROID, 'public void registerPush(PluginCall call)'), /acquirePushRegistration\(call\);/);
  assert.match(body(ANDROID, 'private void acquirePushRegistration('), /ShellPush\.requestToken\(new ShellPush\.Result\(\)/);
  assert.match(ANDROID, /put\(state, "pushSupported", pushAvailable\);/);
  assert.match(APP_GRADLE, /def servicesJSON = file\('google-services\.json'\)\s*if \(servicesJSON\.text\) \{\s*apply plugin: 'com\.google\.gms\.google-services'/, 'app/build.gradle keeps its conditional google-services plugin');
  assert.match(APP_GRADLE, /\} catch\(Exception e\) \{\s*logger\.info\("google-services\.json not found, google-services plugin not applied\. Push Notifications won't work"\)/);
});

test('Android without google-services.json reports push unavailable and never touches FirebaseMessaging', () => {
  const available = body(ANDROID_PUSH, 'static boolean available(Context context)');
  assert.match(available, /try \{\s*return !FirebaseApp\.getApps\(context\)\.isEmpty\(\) \|\| FirebaseApp\.initializeApp\(context\) != null;\s*\} catch \(IllegalStateException error\) \{\s*return false;/);
  assert.match(body(ANDROID, 'public void registerPush(PluginCall call)'), /^[^]*?if \(!pushAvailable\) \{\s*call\.resolve\(pushOutcome\("unavailable", "not_configured"\)\);\s*return;\s*\}/);
  assert.match(body(ANDROID, 'private String pushPermission()'), /if \(!pushAvailable\) \{\s*return "unavailable";/);
  // FirebaseMessaging is reached only through requestToken and deleteToken, and both are behind pushAvailable.
  assert.equal((ANDROID_PUSH_CODE.match(/FirebaseMessaging\.getInstance\(\)/g) || []).length, 2);
  assert.doesNotMatch(code(ANDROID), /FirebaseMessaging/);
  assert.equal((code(ANDROID).match(/ShellPush\.requestToken\(/g) || []).length, 1);
  assert.equal((code(ANDROID).match(/ShellPush\.deleteToken\(\)/g) || []).length, 1);
});

test('Android reports taps from the launch intent and from handleOnNewIntent, once each', () => {
  assert.match(body(ANDROID, 'public void load()'), /Intent launch = getActivity\(\)\.getIntent\(\);\s*if \(ShellPush\.isTap\(launch\)\) \{\s*emitPushTap\(launch\);\s*\} else if/);
  assert.match(ANDROID, /protected void handleOnNewIntent\(Intent intent\) \{\s*if \(ShellPush\.isTap\(intent\)\) \{\s*emitPushTap\(intent\);\s*return;\s*\}/);
  assert.match(body(ANDROID, 'private void emitPushTap('), /String path = ShellPush\.tapPath\(intent\);\s*ShellPush\.consumeTap\(intent\);\s*emit\("pushTapped", object\("path", path\)\);/);
  assert.match(body(ANDROID_PUSH, 'static boolean isTap('), /extras\.containsKey\(FCM_MESSAGE_ID\) \|\| extras\.getBoolean\(EXTRA_TAP, false\)/);
  assert.match(ANDROID_PUSH, /FCM_MESSAGE_ID = "google\.message_id";/);
  const foreground = body(ANDROID_PUSH, 'static void showForeground(');
  assert.match(foreground, /launch\.putExtra\(EXTRA_TAP, true\);/);
  assert.match(foreground, /PendingIntent\.FLAG_IMMUTABLE/);
});

test('sign-out cleanup asks the page, answers at once when nothing is registered, and fails without a page', () => {
  const android = body(ANDROID, 'private void disablePush(int id)');
  assert.match(android, /if \(!pushRegistered\(\)\) \{\s*reply\(id, object\("ok", true\)\);\s*return;/);
  assert.match(android, /evaluateJavascript\("window\.MeroFoundryShell\?\(window\.MeroFoundryShell\._pushDisable\(\),true\):false"/);
  assert.match(android, /if \(!"true"\.equals\(asked\) && pushDisableReply == id\) \{\s*pushDisableReply = 0;\s*reply\(id, object\("ok", false\)\);/);
  assert.match(body(ANDROID, 'public void pushDisabled(PluginCall call)'), /reply\(pending, object\("ok", ok\)\);/);
  const ios = body(IOS, 'private func disablePush(');
  assert.match(ios, /guard push\?\.registered == true else \{\s*reply\(id, \["ok": true\]\)/);
  assert.match(ios, /evaluateJavaScript\("window\.MeroFoundryShell\?\(window\.MeroFoundryShell\._pushDisable\(\),true\):false"\)/);
  assert.match(ios, /\(result as\? Bool\) != true, self\.pushDisableReply == id else \{ return \}\s*self\.pushDisableReply = nil\s*self\.reply\(id, \["ok": false\]\)/);
  assert.match(body(IOS, '@objc func pushDisabled('), /self\.reply\(pending, \["ok": ok\]\)/);
  assert.match(IOS, /case "resetPush":\s*_ = try\? push\?\.unregister\(\)\s*reply\(id, nil\)/);
  assert.match(body(ANDROID, 'private void resetPush('), /forgetPush\(\);/);
});

test('the application id reaches the page only as a validated UUID, and a rejection event only as type and reason', () => {
  assert.match(body(ANDROID, 'private void setPushApplication('), /UUID\.matcher\(applicationId\)\.matches\(\) \? applicationId : ""/);
  assert.match(body(IOS, 'private func setPushApplication('), /value\.range\(of: Self\.uuidPattern, options: \.regularExpression\) != nil \? value : ""/);
  for (const source of [ANDROID, IOS]) {
    assert.match(source, /window\.MeroFoundryShell&&window\.MeroFoundryShell\._setApplicationId\(/);
    assert.match(source, /window\.MeroFoundryShell&&window\.MeroFoundryShell\._pushEvent\(/);
  }
  assert.match(ANDROID, /case "pushEvent":\s*JSONObject event = object\("type", args\.optString\("type", ""\)\);\s*put\(event, "reason", args\.optString\("reason", ""\)\);/);
  assert.match(IOS, /case "pushEvent":\s*let event: \[String: Any\] = \["type": args\["type"\] as\? String \?\? "", "reason": args\["reason"\] as\? String \?\? ""\]/);
  assert.match(IOS, /"pushSupported": push != nil/);
});

test('getPushState carries the native app version and the application id, never a token', () => {
  const android = body(ANDROID, 'private JSObject pushState()');
  assert.match(android, /state\.put\("appVersion", appVersion\(\)\);/);
  assert.match(android, /state\.put\("applicationId", pushApplicationId\.isEmpty\(\) \? JSONObject\.NULL : pushApplicationId\);/);
  const ios = body(IOS, 'private func pushState(');
  assert.match(ios, /result\["appVersion"\] = version/);
  assert.match(ios, /result\["applicationId"\] = applicationId/);
  for (const text of [android, ios, body(IOS_PUSH, 'func state(')]) {
    assert.doesNotMatch(text, /token/i);
  }
});
