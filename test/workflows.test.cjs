'use strict';

/*
 * The customer release workflows. They are parsed and their steps inspected; the guard step is
 * executed against a disposable copy of the starter. No workflow is run, no binary is built and
 * nothing is uploaded.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const { ROOT, starterCopy } = require('./helpers/starter-fixture.cjs');

const WORKFLOWS = { ios: 'ios.yml', android: 'android.yml' };
const BUNDLED = { host: 'shop.example.com', appId: 'com.example.shop', appName: 'Shop', mode: 'bundled', site: 'site' };
const SECRETS = {
  ios: [
    'APPLE_TEAM_ID',
    'APP_STORE_CONNECT_API_ISSUER_ID',
    'APP_STORE_CONNECT_API_KEY_CONTENT',
    'APP_STORE_CONNECT_API_KEY_ID',
    'MATCH_GIT_BASIC_AUTHORIZATION',
    'MATCH_GIT_URL',
    'MATCH_PASSWORD',
  ],
  android: [
    'ANDROID_KEYSTORE_BASE64',
    'ANDROID_KEYSTORE_PASSWORD',
    'ANDROID_KEY_ALIAS',
    'ANDROID_KEY_PASSWORD',
    'PLAY_SERVICE_ACCOUNT_JSON',
  ],
};

function source(platform) {
  return fs.readFileSync(path.join(ROOT, '.github', 'workflows', WORKFLOWS[platform]), 'utf8');
}

function workflow(platform) {
  const doc = YAML.parseDocument(source(platform));
  assert.deepEqual(doc.errors, [], `${WORKFLOWS[platform]} is valid YAML`);
  return doc.toJS();
}

function job(platform) {
  const jobs = Object.values(workflow(platform).jobs);
  assert.equal(jobs.length, 1, 'one release job');
  return jobs[0];
}

/** Index of the first step whose `run` matches, or whose `uses` starts with, the pattern. */
function stepIndex(steps, pattern) {
  return steps.findIndex((step) =>
    typeof pattern === 'string' ? (step.uses || '').startsWith(pattern) : pattern.test(step.run || ''),
  );
}

function step(steps, pattern) {
  const index = stepIndex(steps, pattern);
  assert.ok(index >= 0, `a step matching ${pattern}`);
  return steps[index];
}

function inOrder(steps, ...patterns) {
  const indexes = patterns.map((p) => stepIndex(steps, p));
  indexes.forEach((index, i) => assert.ok(index >= 0, `a step matching ${patterns[i]}`));
  for (let i = 1; i < indexes.length; i += 1) {
    assert.ok(indexes[i - 1] < indexes[i], `${patterns[i - 1]} runs before ${patterns[i]}`);
  }
}

const GUARD = (platform) => new RegExp(`node scripts/release-guard\\.cjs --platform ${platform} --stage workflow`);

for (const platform of Object.keys(WORKFLOWS)) {
  test(`${platform}: the preview guard runs before sync and asset preparation`, () => {
    const { steps } = job(platform);
    inOrder(steps, GUARD(platform), new RegExp(`npx cap sync ${platform}`), new RegExp(`npm run assets -- --${platform}`));
    const guard = step(steps, GUARD(platform));
    assert.equal(guard.if, undefined, 'the guard is unconditional');
  });

  test(`${platform}: the workflow's own guard step rejects a preview override in a fixture`, () => {
    const dir = starterCopy();
    const { run } = step(job(platform).steps, GUARD(platform));
    const exec = (env) => spawnSync('bash', ['-e', '-c', run], { cwd: dir, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
    const rejected = exec({ MEROSHELL_PREVIEW_HOST: 'preview-shop.example.com' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /debug-only/);
    assert.equal(exec({}).status, 0);
  });

  test(`${platform}: installs dependencies from the lockfile before using them`, () => {
    const { steps } = job(platform);
    inOrder(steps, 'actions/checkout', 'actions/setup-node', /^npm ci$/m, new RegExp(`npx cap sync ${platform}`));
  });

  test(`${platform}: reads only the documented customer secrets and no MeroFoundry credential`, () => {
    const text = source(platform);
    const secrets = [...new Set([...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(secrets, SECRETS[platform]);
    assert.doesNotMatch(text, /MERO(?!SHELL_PREVIEW_HOST)|FOUNDRY|KANBAN|FORGEJO/i);
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    for (const secret of secrets) {
      assert.match(readme, new RegExp('`' + secret + '`'), `README documents ${secret}`);
    }
  });

  test(`${platform}: commits, pushes and writes nothing back to the repository`, () => {
    const definition = workflow(platform);
    assert.deepEqual(definition.permissions, { contents: 'read' });
    for (const s of job(platform).steps) {
      assert.doesNotMatch(s.run || '', /git (commit|push|add|tag)|gh release/, s.name);
      assert.ok(!(s.uses || '').match(/commit|push|create-pull-request/i), s.uses);
    }
  });

  test(`${platform}: assembles www after installing dependencies and before Capacitor generates or syncs`, () => {
    const { steps } = job(platform);
    const capacitor = platform === 'ios' ? [/npx cap add ios/, /npx cap sync ios/] : [/npx cap sync android/];
    inOrder(steps, /^npm ci$/m, /^npm run web$/m, ...capacitor);
    assert.equal(step(steps, /^npm run web$/m).if, undefined, 'www is assembled on every run');
  });

  test(`${platform}: the workflow's own web step assembles a bundled site, and the guard refuses a missing one`, () => {
    const dir = starterCopy({ starter: BUNDLED, siteFiles: { 'index.html': '<!doctype html><title>Shop</title>' } });
    const steps = job(platform).steps;
    const exec = (run) => spawnSync('bash', ['-e', '-c', run], { cwd: dir, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    const web = exec(step(steps, /^npm run web$/m).run);
    assert.equal(web.status, 0, web.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'www', 'index.html')));
    assert.ok(fs.existsSync(path.join(dir, 'www', 'meroshell', 'index.html')));
    fs.rmSync(path.join(dir, 'site'), { recursive: true });
    const guard = exec(step(steps, GUARD(platform)).run);
    assert.equal(guard.status, 1);
    assert.match(guard.stderr, /site "site"/);
  });

  test(`${platform}: never sets the preview override`, () => {
    assert.doesNotMatch(source(platform), /MEROSHELL_PREVIEW_HOST\s*:/);
  });
}

test('ios: macOS runner regenerates the project on every run, prepares it, then builds with fastlane', () => {
  const ios = job('ios');
  assert.equal(ios['runs-on'], 'macos-latest');
  const steps = ios.steps;
  const add = step(steps, /npx cap add ios/);
  assert.equal(add.if, undefined, 'cap add ios runs on every run');
  inOrder(
    steps,
    GUARD('ios'),
    /^npm run web$/m,
    /npx cap add ios/,
    /npx cap sync ios/,
    /npm run ios:prepare/,
    /npm run assets -- --ios/,
    /bundle exec fastlane ios release/,
  );
  assert.ok(stepIndex(steps, 'ruby/setup-ruby') >= 0);
});

test('ios: fastlane signs with readonly match and uploads to TestFlight', () => {
  const fastfile = fs.readFileSync(path.join(ROOT, 'fastlane', 'Fastfile'), 'utf8');
  const match = fastfile.match(/match\(([\s\S]*?)\)\n/);
  assert.ok(match, 'match is called');
  assert.match(match[1], /readonly: true/);
  assert.match(match[1], /type: 'appstore'/);
  assert.match(fastfile, /app_store_connect_api_key\(/);
  assert.match(fastfile, /^PROJECT = 'ios\/App\/App\.xcodeproj'$/m);
  assert.match(fastfile, /build_app\([\s\S]*?project: PROJECT,[\s\S]*?configuration: 'Release'/);
  assert.match(fastfile, /upload_to_testflight\(/);
  assert.doesNotMatch(fastfile, /readonly: false|register_devices|deliver\(|upload_to_app_store/);
  const gemfile = fs.readFileSync(path.join(ROOT, 'Gemfile'), 'utf8');
  assert.match(gemfile, /gem 'fastlane'/);
  const env = step(job('ios').steps, /bundle exec fastlane ios release/).env;
  for (const name of SECRETS.ios) {
    assert.ok(Object.values(env).some((v) => String(v).includes(`secrets.${name}`)), `fastlane receives ${name}`);
  }
});

test('android: Ubuntu runner builds a signed AAB and uploads it to the internal track', () => {
  const android = job('android');
  assert.equal(android['runs-on'], 'ubuntu-latest');
  const steps = android.steps;
  inOrder(
    steps,
    GUARD('android'),
    /^npm run web$/m,
    /npx cap sync android/,
    /npm run assets -- --android/,
    /\.\/gradlew bundleRelease/,
    'r0adkll/upload-google-play',
  );
  const build = step(steps, /\.\/gradlew bundleRelease/);
  for (const name of ['ANDROID_KEYSTORE_FILE', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD', 'ANDROID_VERSION_CODE']) {
    assert.ok(name in build.env, `bundleRelease receives ${name}`);
  }
  const upload = step(steps, 'r0adkll/upload-google-play');
  assert.equal(upload.with.track, 'internal');
  assert.equal(upload.with.releaseFiles, 'android/app/build/outputs/bundle/release/app-release.aab');
  assert.match(upload.with.serviceAccountJsonPlainText, /secrets\.PLAY_SERVICE_ACCOUNT_JSON/);
  assert.match(upload.with.packageName, /steps\.starter\.outputs\.appId/);
});

test('android: the keystore is decoded outside the repository', () => {
  const decode = step(job('android').steps, /base64 --decode/);
  assert.match(decode.run, /RUNNER_TEMP/);
});
