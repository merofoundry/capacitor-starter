'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PULL_THRESHOLD } = require('../shell/hosted-integration.js');

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

function section(heading) {
  const start = README.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `README has a "${heading}" section`);
  const end = README.indexOf('\n## ', start + 1);
  return README.slice(start, end < 0 ? undefined : end);
}

test('www is assembled first, then npx cap add ios is the first iOS project step', () => {
  const ios = section('3. iOS');
  const commands = ios.match(/```sh\n([\s\S]*?)```/)[1].trim().split('\n');
  assert.deepEqual(commands.slice(0, 5), ['npm run web', 'npx cap add ios', 'npx cap sync ios', 'npm run ios:prepare', 'npm run assets -- --ios']);
});

// The MeroFoundry app-store guide, present only while the starter sits in the MeroFoundry repository.
const GUIDE = path.join(__dirname, '..', '..', '..', 'docs', 'publish-to-the-app-stores.md');

test('every documented Capacitor add or sync is preceded by npm run web in the same snippet', () => {
  const documents = [['README.md', README]];
  if (fs.existsSync(GUIDE)) {
    documents.push(['publish-to-the-app-stores.md', fs.readFileSync(GUIDE, 'utf8')]);
  }
  for (const [name, text] of documents) {
    const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]);
    const capacitor = blocks.filter((block) => /npx cap (add|sync)/.test(block));
    assert.ok(capacitor.length >= 2, `${name} has Capacitor snippets`);
    for (const block of capacitor) {
      const web = block.indexOf('npm run web');
      assert.ok(web >= 0 && web < block.search(/npx cap (add|sync)/), `${name}: ${block.trim()}`);
    }
  }
});

test('Configure documents mode, the bundled site and the assembled www', () => {
  const configure = section('1. Configure');
  assert.match(configure, /`mode` is optional: `"remote"` \(the default when omitted\) or `"bundled"`/);
  assert.match(configure, /capacitor:\/\/localhost/);
  assert.match(configure, /https:\/\/localhost/);
  assert.match(configure, /`site` is required in bundled mode and refused in remote mode/);
  assert.match(configure, /relative to this\s+directory/);
  assert.match(configure, /\*\*already-built\*\* site/);
  assert.match(configure, /`index\.html`/);
  assert.match(configure, /never builds your site/);
  assert.match(configure, /"mode": "bundled",\s*"site": "\.\.\/my-site\/dist"/);
  assert.match(configure, /`npm run web` assembles `www\/`/);
  assert.match(configure, /`www\/meroshell\/`/);
  assert.match(configure, /The `meroshell\/` path is reserved/);
  assert.match(configure, /not committed/);
  assert.match(configure, /bridge logging is off/);
});

test('the session API and its secure storage are documented', () => {
  const hosted = section('Hosted-page integration');
  assert.match(hosted, /MeroFoundryShell\.session\.save\(\{ accessToken, refreshToken \}\)/);
  assert.match(hosted, /MeroFoundryShell\.session\.load\(\); \/\/ \{accessToken, refreshToken\} or null/);
  assert.match(hosted, /MeroFoundryShell\.session\.clear\(\)/);
  assert.match(hosted, /Keychain \(service = your `appId`, available after first\s+unlock, this device only\)/);
  assert.match(hosted, /EncryptedSharedPreferences under an Android\s+Keystore master key/);
  assert.match(hosted, /in remote mode only into pages on your configured host, in bundled mode only into pages\s+on the app's local origin/);
});

test('the release guard documents the web-asset freshness check', () => {
  const preview = section('Preview builds');
  assert.match(preview, /`www\/` or the\s+platform's copy of it is missing or stale/);
  assert.match(preview, /compares content, not\s+timestamps/);
});

test('the customer prerequisites for signing and the stores are documented', () => {
  const release = section('Release workflows');
  assert.match(release, /match/);
  assert.match(release, /readonly/);
  assert.match(release, /App Store Connect/);
  assert.match(release, /One manual upload/);
  assert.match(release, /Play App Signing/);
});

test('hosted-page integration, app lock, sign-out and association files are documented', () => {
  assert.match(section('Hosted-page integration'), /window\.MeroFoundryShell/);
  assert.match(section('Hosted-page integration'), /--meroshell-safe-area-inset-top/);
  assert.match(section('App lock'), /independent of the server session/);
  assert.match(section('Sign out'), /deletes every cookie/);
  const links = section('Deep links');
  assert.match(links, /apple-app-site-association/);
  assert.match(links, /assetlinks\.json/);
  assert.match(links, /Otherwise you own these files/);
});

test('pull to refresh is documented as starter-local, authorized, and distinct from the official plugins', () => {
  const refresh = section('Pull to refresh');
  assert.match(refresh, /Authorized by Rob\s+on 2026-10-17/);
  assert.match(refresh, /official Capacitor plugin catalog has no\s+pull-to-refresh plugin/);
  assert.match(refresh, /official `@capacitor\/share` and\s+`@capacitor\/haptics` plugins/);
  assert.match(refresh, /no general-purpose plugin project/);
  assert.match(refresh, /lock screen/);
  assert.match(refresh, /offline screen/);
  assert.match(refresh, /data-meroshell-pull-refresh="off"/);
  assert.match(refresh, new RegExp(`at least ${PULL_THRESHOLD} pixels down`));
  assert.doesNotMatch(README, /Pull to refresh is not part of this version/);
});

test('provider sign-in is documented as a capability, not a blanket restriction', () => {
  assert.doesNotMatch(README, /does not work inside the shell/);
  assert.match(section('Hosted-page integration'), /data-meroshell-provider-sign-in="on"/);
  const signIn = section('Provider sign-in');
  assert.match(signIn, /MeroFoundryShell\.capabilities\.providerSignIn/);
  assert.match(signIn, /meroshell:capabilities/);
  assert.match(signIn, /MeroFoundryShell\.providerSignIn\(href\)/);
  assert.match(signIn, /Provider sign-in is not available in this app/);
  assert.match(signIn, /ASWebAuthenticationSession/);
  assert.match(signIn, /Custom Tab/);
  assert.match(signIn, /iOS 17\.4 or later/);
  assert.match(signIn, /Android 12 or later, a\s+verified App Links association/);
  assert.match(signIn, /\/api\/v1\/applications\/<application id>\/auth\/oauth\/exchange/);
});

test('provider sign-in documents the catalog prerequisite and that it fails closed', () => {
  const signIn = section('Provider sign-in');
  assert.match(signIn, /\/api\/v1\/applications\/public\/by-host/);
  assert.match(signIn, /\/\.well-known\/api-catalog/);
  assert.match(signIn, /"mobile_shell": \{"provider_sign_in": true\}/);
  assert.match(signIn, /mobile_distribution/);
  assert.match(signIn, /once per launch and again after \*\*Sign out\*\*/);
  assert.match(signIn, /fails closed: if the catalog is not published/);
  assert.match(signIn, /identity_settings\.mobile_apps/);
});

test('provider buttons in the examples are href-bearing links', () => {
  const signIn = section('Provider sign-in');
  const examples = [...signIn.matchAll(/<a href="[^"]+" data-provider-sign-in="(\w+)">/g)].map((m) => m[1]);
  assert.deepEqual(examples, ['google', 'github']);
  assert.doesNotMatch(signIn, /<button[^>]*data-provider-sign-in/);
});

test('the deep-link prerequisite names identity_settings.mobile_apps beside self-published files', () => {
  const links = section('Deep links');
  assert.match(links, /identity_settings\.mobile_apps/);
  assert.match(links, /mobile_distribution/);
  assert.match(links, /Provider sign-in needs the same files/);
});

test('the unresolved callback-binding conflict is stated and no end-to-end success is claimed', () => {
  const signIn = section('Provider sign-in');
  assert.match(signIn, /### Known open issue/);
  assert.match(signIn, /browser-binding cookie/);
  assert.match(signIn, /not known to complete\s+end to end/);
  assert.match(signIn, /never on a device/);
});

test('the app-store guide\'s Configure section documents mode and site', (t) => {
  if (!fs.existsSync(GUIDE)) {
    t.skip('the MeroFoundry app-store guide is not beside this starter');
    return;
  }
  const guide = fs.readFileSync(GUIDE, 'utf8');
  const start = guide.indexOf('\n### Configure the shell\n');
  assert.ok(start >= 0);
  const configure = guide.slice(start, guide.indexOf('\n### ', start + 1));
  assert.match(configure, /`mode` is optional/);
  assert.match(configure, /`"remote"`, the default when `mode` is omitted/);
  assert.match(configure, /`"bundled"`/);
  assert.match(configure, /`site` is required in bundled mode and refused in remote mode/);
  assert.match(configure, /already-built site/);
  assert.match(configure, /`www\/meroshell\/`/);
  assert.match(configure, /`meroshell\/` path is reserved/);
  assert.match(configure, /capacitor:\/\/localhost` on iOS and `https:\/\/localhost` on Android/);
});

/** The `## ` headings of a markdown text, in order. */
const headings = (text) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

test('Bundled mode is followed immediately by Push notifications, and then App lock', () => {
  const order = headings(README);
  assert.equal(order[order.indexOf('Push notifications') - 1], 'Bundled mode');
  assert.equal(order[order.indexOf('App lock') - 1], 'Push notifications');
  const bundled = section('Bundled mode');
  assert.match(bundled, /already-built static site/);
  assert.match(bundled, /page builder[\s\S]*cannot be bundled/);
  assert.match(bundled, /`update_application`/);
  assert.match(bundled, /"allowedOrigins": \["capacitor:\/\/localhost", "https:\/\/localhost"\]/);
  assert.match(bundled, /`mobile_distribution` capability/);
  for (const method of ['login', 'fetch', 'signedIn', 'logout']) {
    assert.match(bundled, new RegExp(`MeroFoundryShell\\.bearer\\.${method}\\(`), method);
  }
  assert.match(bundled, /refreshes the pair once by body, saves it and retries once/);
  assert.match(bundled, /`session=bearer`/);
  assert.match(bundled, /`meroshell:session`[\s\S]*`\{signedIn: true\}` and no token/);
  assert.match(bundled, /offline screen appears only when a\s+navigation to `https:\/\/<host>` fails during a provider sign-in/);
  assert.match(bundled, /removes the saved pair, then the WebView's cookies, and reloads the\s+bundled site's root/);
});

test('Push notifications documents setup, the site API, renewal, taps, sign-out and parity', () => {
  const push = section('Push notifications');
  assert.match(push, /no JavaScript push plugin/);
  assert.match(push, /`android\/app\/google-services\.json`/);
  assert.match(push, /Without it the app still builds and runs, and push answers `unavailable` with\s+reason `not_configured`/);
  assert.match(push, /APNs authentication key\s+\(\.p8\)/);
  assert.match(push, /Push Notifications capability for your App ID/);
  assert.match(push, /FCM HTTP v1 API/);
  assert.match(push, /`aps-environment` = `development`/);
  assert.match(push, /distribution profile, which sets `aps-environment` to `production`/);
  assert.match(push, /`mobile_distribution` capability/);
  for (const method of ['enable', 'state', 'disable']) {
    assert.match(push, new RegExp(`MeroFoundryShell\\.push\\.${method}\\(`), method);
  }
  assert.match(push, /works the same way in remote and bundled mode/);
  assert.match(push, /page's cookies and `X-Requested-With`; in bundled mode it goes through\s+`MeroFoundryShell\.bearer\.fetch`/);
  assert.match(push, /PUT https:\/\/<host>\/api\/v1\/public\/applications\/<application id>\/push\/devices`/);
  assert.match(push, /DELETE https:\/\/<host>\/api\/v1\/public\/applications\/<application id>\/push\/devices\/<token>`/);
  assert.match(push, /`navigator\.language`/);
  assert.match(push, /### Renewal[\s\S]*a day or more after the last\s+renewal/);
  assert.match(push, /### Taps[\s\S]*at most 1024 characters/);
  assert.match(push, /`meroshell:push`[\s\S]*`\{type: 'rejected', reason\}` and no path/);
  assert.match(push, /### Sign out and settings[\s\S]*waits at most five\s+seconds/);
  assert.match(push, /\*\*Notifications\*\* as \*\*On\*\* or \*\*Off\*\*\. It has no switch/);
  const signOut = section('Sign out');
  assert.match(signOut, /first has your page turn push notifications off/);
});

test('Sign out documents the bundled behaviour and the mode label', () => {
  const signOut = section('Sign out');
  assert.match(signOut, /In bundled mode \*\*Sign out\*\* first removes the token pair saved in secure storage/);
  assert.match(signOut, /reloads the root of the bundled site/);
  assert.match(signOut, /\*\*Bundled\*\* or\s+\*\*Remote\*\* beside the host/);
});

test('the app-store guide has Bundled mode immediately before Step 3 and bundled sign-out', (t) => {
  if (!fs.existsSync(GUIDE)) {
    t.skip('the MeroFoundry app-store guide is not beside this starter');
    return;
  }
  const guide = fs.readFileSync(GUIDE, 'utf8');
  const order = headings(guide);
  const step3 = order.findIndex((h) => h.startsWith('Step 3:'));
  assert.equal(order[step3 - 1], 'Bundled mode');
  const start = guide.indexOf('\n## Bundled mode\n');
  const bundled = guide.slice(start, guide.indexOf('\n## Step 3:', start));
  assert.match(bundled, /Bring your own static build/);
  assert.match(bundled, /page builder/);
  assert.match(bundled, /`update_application`/);
  assert.match(bundled, /"allowedOrigins": \["capacitor:\/\/localhost", "https:\/\/localhost"\]/);
  assert.match(bundled, /`mobile_distribution`\s+capability/);
  assert.match(bundled, /MeroFoundryShell\.bearer/);
  assert.match(bundled, /\*\*Sign out\*\*/);
  const adds = guide.slice(guide.indexOf('\n### What the shell adds\n'), guide.indexOf('\n### Use the shell from your site\n'));
  assert.match(adds, /In bundled mode\s+it first removes the bearer token pair/);
  assert.doesNotMatch(guide, /\u2014/, 'no em dash');
});

test('the README has no em dash', () => {
  assert.doesNotMatch(README, /\u2014/);
});
