'use strict';

/*
 * Fresh iOS generation fixtures. Each test runs the real `npx cap add ios` and `npx cap sync ios`
 * into a disposable copy of the starter and then the starter's own preparation step, exactly
 * as the iOS workflow does. Nothing is compiled or signed: Xcode is not available here, so
 * these tests establish the generated project files, not that Xcode accepts them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ios = require('../lib/ios-project.cjs');
const { cap, node, starterCopy } = require('./helpers/starter-fixture.cjs');

const STARTER = { host: 'shop.example.com', appId: 'com.example.shop', appName: 'Shop & Co' };
const PREPARED = [ios.IOS_FILES.infoPlist, ios.IOS_FILES.entitlements, ios.IOS_FILES.pbxproj];

function freshIos(starter = STARTER) {
  const dir = starterCopy({ starter });
  cap(dir, ['add', 'ios']);
  cap(dir, ['sync', 'ios']);
  return dir;
}

function prepare(dir) {
  const run = node(dir, ['scripts/prepare-ios.cjs']);
  assert.equal(run.status, 0, run.stderr);
  return run;
}

function read(dir, file) {
  return fs.readFileSync(path.join(dir, file), 'utf8');
}

function snapshot(dir) {
  return Object.fromEntries(PREPARED.map((file) => [file, read(dir, file)]));
}

test('preparation refuses to run before npx cap add ios', () => {
  const dir = starterCopy({ starter: STARTER });
  const run = node(dir, ['scripts/prepare-ios.cjs']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /npx cap add ios/);
});

test('preparation refuses a generated project that was not synced with the bootstrap', () => {
  const dir = starterCopy({ starter: STARTER });
  cap(dir, ['add', 'ios']);
  fs.rmSync(path.join(dir, 'ios', 'App', 'App', 'capacitor.config.json'));
  const run = node(dir, ['scripts/prepare-ios.cjs']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /npx cap sync ios/);
});

test('fresh generation: Face ID text, display name and bundle id come from starter.config.json', () => {
  const dir = freshIos();
  prepare(dir);
  const plist = read(dir, ios.IOS_FILES.infoPlist);
  assert.equal(ios.readPlistString(plist, 'NSFaceIDUsageDescription'), 'Shop &amp; Co uses Face ID to unlock the app.');
  assert.equal(ios.readPlistString(plist, 'CFBundleDisplayName'), 'Shop &amp; Co');
  const pbxproj = read(dir, ios.IOS_FILES.pbxproj);
  const ids = [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['com.example.shop', 'com.example.shop']);
});

test('fresh generation: universal links are restricted to the configured host', () => {
  const dir = freshIos();
  prepare(dir);
  const entitlements = read(dir, ios.IOS_FILES.entitlements);
  assert.match(entitlements, /<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>\s*<string>applinks:shop\.example\.com<\/string>\s*<\/array>/);
  assert.equal((entitlements.match(/applinks:/g) || []).length, 1);
  const pbxproj = read(dir, ios.IOS_FILES.pbxproj);
  assert.equal((pbxproj.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g) || []).length, 2, 'Debug and Release');
});

test('fresh generation: the bootstrap plugin and its bundled pages are integrated by sync', () => {
  const dir = freshIos();
  prepare(dir);
  const generated = JSON.parse(read(dir, path.join('ios', 'App', 'App', 'capacitor.config.json')));
  assert.ok(generated.packageClassList.includes('MeroShellPlugin'));
  assert.match(read(dir, path.join('ios', 'App', 'CapApp-SPM', 'Package.swift')), /\.product\(name: "MeroshellBootstrap"/);
  for (const page of ['index.html', 'hosted-integration.js', 'controller.js']) {
    assert.ok(fs.existsSync(path.join(dir, 'ios', 'App', 'App', 'public', page)), page);
  }
  const hosted = read(dir, path.join('ios', 'App', 'App', 'public', 'hosted-integration.js'));
  assert.equal(hosted, fs.readFileSync(path.join(__dirname, '..', 'shell', 'hosted-integration.js'), 'utf8'));
  assert.match(hosted, /function createPullToRefresh/, 'the generated project carries pull to refresh');
  const plugin = path.join('node_modules', 'meroshell-bootstrap', 'ios', 'Sources', 'MeroShellPlugin', 'MeroShellPlugin.swift');
  assert.match(read(dir, plugin), /CAPPluginMethod\(name: "refresh"/);
});

test('fresh generation: a release build phase runs the package-stage guard before compiling', () => {
  const dir = freshIos();
  prepare(dir);
  const pbxproj = read(dir, ios.IOS_FILES.pbxproj);
  const target = pbxproj.match(/\/\* App \*\/ = \{\s*isa = PBXNativeTarget;[\s\S]*?buildPhases = \(([\s\S]*?)\);/);
  assert.ok(target, 'App target found');
  const phases = target[1].trim().split(/,\s*/).filter(Boolean);
  assert.match(phases[0], /MeroShell release guard/);
  assert.match(phases[1], /Sources/);
  const phase = pbxproj.match(/\/\* MeroShell release guard \*\/ = \{([\s\S]*?)\n\t\t\};/);
  assert.ok(phase, 'phase definition present');
  assert.match(phase[1], /isa = PBXShellScriptBuildPhase;/);
  assert.match(phase[1], /alwaysOutOfDate = 1;/);
  const script = JSON.parse(phase[1].match(/shellScript = ("(?:[^"\\]|\\.)*");/)[1]);
  assert.match(script, /"\$\{CONFIGURATION\}" != "Debug"/);
  assert.match(script, /node scripts\/release-guard\.cjs --platform ios --stage package/);
});

test('the release build phase script blocks a preview-synced project and passes a clean one', () => {
  const dir = freshIos();
  prepare(dir);
  const script = ios.releaseGuardScript();
  const { spawnSync } = require('node:child_process');
  const run = (env) =>
    spawnSync('/bin/sh', ['-c', script], {
      env: { PATH: process.env.PATH, SRCROOT: path.join(dir, 'ios', 'App'), CONFIGURATION: 'Release', ...env },
      encoding: 'utf8',
    });
  assert.equal(run({}).status, 0, run({}).stderr);
  assert.equal(run({ MEROSHELL_PREVIEW_HOST: 'preview-shop.example.com' }).status, 1);
  cap(dir, ['sync', 'ios'], { MEROSHELL_PREVIEW_HOST: 'preview-shop.example.com' });
  const stale = run({});
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /preview-shop\.example\.com/);
  assert.equal(run({ CONFIGURATION: 'Debug' }).status, 0, 'debug builds may use the preview host');
});

test('preparation is repeatable: a second run changes nothing', () => {
  const dir = freshIos();
  prepare(dir);
  const first = snapshot(dir);
  const again = prepare(dir);
  assert.deepEqual(snapshot(dir), first);
  assert.match(again.stdout, /already prepared/);
});

test('two fresh generations prepare to identical native files', () => {
  const a = freshIos();
  const b = freshIos();
  prepare(a);
  prepare(b);
  assert.deepEqual(snapshot(a), snapshot(b));
});

test('plist editing replaces an existing value and inserts a missing one, escaping XML', () => {
  const plist = '<plist version="1.0">\n<dict>\n\t<key>A</key>\n\t<string>old</string>\n</dict>\n</plist>\n';
  const replaced = ios.setPlistString(plist, 'A', 'new <value>');
  assert.equal(ios.readPlistString(replaced, 'A'), 'new &lt;value&gt;');
  const inserted = ios.setPlistString(replaced, 'B', 'b');
  assert.equal(ios.readPlistString(inserted, 'B'), 'b');
  assert.equal(ios.setPlistString(inserted, 'B', 'b'), inserted);
});
