'use strict';

/*
 * The committed Android project's starter integration. These tests read the committed Gradle
 * and manifest files and run the real Capacitor CLI and asset generator against a disposable
 * copy. Gradle and the Android SDK are not run here, so they establish what the project
 * declares, not that a device build accepts it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ROOT, cap, node, starterCopy } = require('./helpers/starter-fixture.cjs');

const STARTER = { host: 'shop.example.com', appId: 'com.example.shop', appName: 'Shop' };
const PREVIEW = { MEROSHELL_PREVIEW_HOST: 'preview-shop.example.com' };
const MANIFEST = path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml');
const APP_GRADLE = path.join('android', 'app', 'build.gradle');

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');

function intentFilters(manifest) {
  return [...manifest.matchAll(/<intent-filter([^>]*)>([\s\S]*?)<\/intent-filter>/g)].map((m) => ({ attrs: m[1], body: m[2] }));
}

function deepLinkFilter(manifest) {
  return intentFilters(manifest).find((f) => f.body.includes('android.intent.action.VIEW'));
}

function guardCommand(gradle) {
  const match = gradle.match(/commandLine ((?:'[^']*'(?:, )?)+)/);
  assert.ok(match, 'the release guard task declares its command');
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

test('the main activity verifies https deep links for the configured host only', () => {
  const manifest = read(ROOT, MANIFEST);
  const filter = deepLinkFilter(manifest);
  assert.ok(filter, 'a VIEW intent filter exists');
  assert.match(filter.attrs, /android:autoVerify="true"/);
  assert.match(filter.body, /android\.intent\.category\.BROWSABLE/);
  assert.match(filter.body, /android\.intent\.category\.DEFAULT/);
  const data = [...filter.body.matchAll(/<data ([^>]*)\/>/g)].map((m) => m[1]);
  assert.deepEqual(data.map((d) => d.match(/android:scheme="([^"]+)"/)?.[1]).filter(Boolean), ['https']);
  assert.deepEqual(data.map((d) => d.match(/android:host="([^"]+)"/)?.[1]).filter(Boolean), ['${shellHost}']);
  assert.doesNotMatch(filter.body, /pathPrefix|pathPattern|\*/);
});

test('the application id, label and deep-link host are read from starter.config.json', () => {
  const gradle = read(ROOT, APP_GRADLE);
  assert.match(gradle, /JsonSlurper\(\)\.parse\(rootProject\.file\('\.\.\/starter\.config\.json'\)\)/);
  assert.match(gradle, /applicationId starter\.appId/);
  assert.match(gradle, /shellHost: starter\.host/);
  assert.match(gradle, /shellAppName: starter\.appName/);
  const manifest = read(ROOT, MANIFEST);
  assert.equal((manifest.match(/android:label="\$\{shellAppName\}"/g) || []).length, 2);
});

test('release signing uses only the customer keystore from the environment', () => {
  const gradle = read(ROOT, APP_GRADLE);
  for (const name of ['ANDROID_KEYSTORE_FILE', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) {
    assert.match(gradle, new RegExp(`System\\.getenv\\('${name}'\\)`), name);
  }
  assert.match(gradle, /release \{[\s\S]*?signingConfig signingConfigs\.release/);
  assert.doesNotMatch(gradle, /storePassword ['"]/, 'no literal passwords');
});

test('every release variant runs the package-stage guard before it builds', () => {
  const gradle = read(ROOT, APP_GRADLE);
  assert.match(gradle, /tasks\.register\('meroshellReleaseGuard', Exec\)/);
  assert.match(gradle, /workingDir rootProject\.file\('\.\.'\)/);
  assert.match(gradle, /tasks\.matching \{ it\.name ==~ \/pre\\w\*ReleaseBuild\/ \}\.configureEach \{ dependsOn meroshellReleaseGuard \}/);
  assert.deepEqual(guardCommand(gradle), ['node', 'scripts/release-guard.cjs', '--platform', 'android', '--stage', 'package']);
});

test('the Gradle guard command rejects a preview-synced project and an override, and passes a clean sync', () => {
  const dir = starterCopy({ starter: STARTER, withAndroid: true });
  const [bin, ...args] = guardCommand(read(dir, APP_GRADLE));
  assert.equal(bin, 'node');
  const run = (env = {}) => node(dir, args, env);

  cap(dir, ['sync', 'android'], PREVIEW);
  const stale = run();
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /preview-shop\.example\.com/);

  cap(dir, ['sync', 'android']);
  assert.equal(run().status, 0, run().stderr);
  assert.equal(run(PREVIEW).status, 1);
});

test('sync registers the shell bootstrap and copies the bundled pages', () => {
  const dir = starterCopy({ starter: STARTER, withAndroid: true });
  cap(dir, ['sync', 'android']);
  const plugins = JSON.parse(read(dir, path.join('android', 'app', 'src', 'main', 'assets', 'capacitor.plugins.json')));
  assert.ok(plugins.some((p) => p.classpath === 'app.merofoundry.shell.MeroShellPlugin'));
  assert.match(read(dir, path.join('android', 'capacitor.settings.gradle')), /include ':meroshell-bootstrap'/);
  assert.match(read(dir, path.join('android', 'app', 'capacitor.build.gradle')), /implementation project\(':meroshell-bootstrap'\)/);
  for (const page of ['index.html', 'hosted-integration.js']) {
    assert.ok(fs.existsSync(path.join(dir, 'android', 'app', 'src', 'main', 'assets', 'public', page)), page);
  }
  const hosted = read(dir, path.join('android', 'app', 'src', 'main', 'assets', 'public', 'hosted-integration.js'));
  assert.equal(hosted, read(ROOT, path.join('shell', 'hosted-integration.js')));
  assert.match(hosted, /function createPullToRefresh/, 'the synced project carries pull to refresh');
  const generated = JSON.parse(read(dir, path.join('android', 'app', 'src', 'main', 'assets', 'capacitor.config.json')));
  assert.equal(generated.server.url, 'https://shop.example.com');
});

test('the bootstrap declares the biometric permission it uses', () => {
  const manifest = read(ROOT, path.join('native', 'shell-bootstrap', 'android', 'src', 'main', 'AndroidManifest.xml'));
  assert.match(manifest, /android\.permission\.USE_BIOMETRIC/);
});

test('generated artwork lands in the native projects and keeps the deep-link filter', () => {
  const dir = starterCopy({ starter: STARTER, withAndroid: true });
  const res = path.join(dir, 'android', 'app', 'src', 'main', 'res');
  // Start from what a clone contains: none of the ignored artwork.
  for (const entry of fs.readdirSync(res)) {
    if (entry.startsWith('mipmap-')) {
      fs.rmSync(path.join(res, entry), { recursive: true });
    } else if (entry.startsWith('drawable')) {
      fs.rmSync(path.join(res, entry, 'splash.png'), { force: true });
    }
  }
  const run = node(dir, ['scripts/prepare-assets.cjs', '--android']);
  assert.equal(run.status, 0, run.stderr);
  for (const file of [
    'mipmap-anydpi-v26/ic_launcher.xml',
    'mipmap-anydpi-v26/ic_launcher_round.xml',
    'mipmap-xxxhdpi/ic_launcher.png',
    'mipmap-xxxhdpi/ic_launcher_round.png',
    'mipmap-xxxhdpi/ic_launcher_foreground.png',
    'mipmap-xxxhdpi/ic_launcher_background.png',
    'drawable/splash.png',
    'drawable-night/splash.png',
  ]) {
    assert.ok(fs.existsSync(path.join(res, file)), file);
  }
  const filter = deepLinkFilter(read(dir, MANIFEST));
  assert.ok(filter, '@capacitor/assets rewrites the manifest; the filter must survive');
  assert.match(filter.attrs, /android:autoVerify="true"/);
  assert.match(filter.body, /android:host="\$\{shellHost\}"/);
});

test('version control excludes ios/, generated artwork, copied web assets and build output', () => {
  const ignore = read(ROOT, '.gitignore').split('\n').map((line) => line.trim());
  for (const pattern of [
    '/ios/',
    '/node_modules',
    '/.assets-build/',
    '/build/',
    '/android/app/src/main/res/mipmap-*/',
    '/android/app/src/main/res/drawable*/splash.png',
  ]) {
    assert.ok(ignore.includes(pattern), pattern);
  }
  const androidIgnore = read(ROOT, path.join('android', '.gitignore'));
  assert.match(androidIgnore, /^app\/src\/main\/assets\/public$/m);
  assert.match(androidIgnore, /^build\/$/m);
});

test('git, when present, ignores the generated paths of a prepared checkout', (t) => {
  const git = spawnSync('git', ['--version']);
  if (git.status !== 0) {
    t.skip('git is not installed');
    return;
  }
  const dir = starterCopy({ starter: STARTER, withAndroid: true });
  fs.copyFileSync(path.join(ROOT, '.gitignore'), path.join(dir, '.gitignore'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const paths = [
    'ios/App/App/Info.plist',
    'node_modules',
    '.assets-build/icon-only.png',
    'android/app/src/main/res/mipmap-hdpi/ic_launcher.png',
    'android/app/src/main/res/drawable-port-night-hdpi/splash.png',
    'android/app/src/main/assets/public/index.html',
    'android/app/build/outputs/bundle/release/app-release.aab',
  ];
  const ignored = spawnSync('git', ['check-ignore', '--no-index', ...paths], { cwd: dir, encoding: 'utf8' });
  assert.deepEqual(ignored.stdout.trim().split('\n'), paths);
  const kept = spawnSync('git', ['check-ignore', '--no-index', 'android/app/src/main/AndroidManifest.xml', 'assets/icon.png'], { cwd: dir });
  assert.equal(kept.status, 1, 'source files are not ignored');
});
