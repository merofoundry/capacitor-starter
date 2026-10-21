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

test('npx cap add ios is the first iOS project step', () => {
  const ios = section('3. iOS');
  const commands = ios.match(/```sh\n([\s\S]*?)```/)[1].trim().split('\n');
  assert.equal(commands[0], 'npx cap add ios');
  assert.deepEqual(commands.slice(1, 4), ['npx cap sync ios', 'npm run ios:prepare', 'npm run assets -- --ios']);
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
  assert.match(links, /You own these files/);
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
