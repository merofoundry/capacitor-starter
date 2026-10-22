'use strict';

/*
 * www/ assembly (npm run web) and its freshness check. Every fixture is a temporary starter
 * root with its own small shell/ and site; nothing here compiles a site.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { tempDir } = require('./helpers/temp.cjs');
const { ROOT } = require('./helpers/starter-fixture.cjs');
const { MANIFEST, WebAssetsError, assembledAssetsError, prepareWeb } = require('../lib/web-assets.cjs');
const { ShellConfigError } = require('../lib/shell-config.cjs');

const STARTER = { host: 'shop.example.com', appId: 'com.example.shop', appName: 'Shop' };
const BUNDLED = { ...STARTER, mode: 'bundled', site: 'site' };
const SHELL = { 'index.html': '<!doctype html><title>shell</title>', 'js/controller.js': 'controller()', 'shell.css': 'a{}' };
const SITE = { 'index.html': '<!doctype html><title>Shop</title>', 'assets/app.js': 'app()', 'assets/img/logo.svg': '<svg/>' };

function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}

/** A starter root with shell/, starter.config.json and, for bundled mode, site/. */
function starterRoot(starter = STARTER, { site = SITE } = {}) {
  const dir = tempDir('meroshell-web-');
  write(dir, { 'starter.config.json': JSON.stringify(starter), 'package.json': JSON.stringify({ version: '1.0.0' }) });
  write(path.join(dir, 'shell'), SHELL);
  if (starter.mode === 'bundled') {
    write(path.join(dir, starter.site), site);
  }
  return dir;
}

const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');
const www = (dir) => path.join(dir, 'www');
const exists = (dir, name) => fs.existsSync(path.join(dir, name));
const fresh = (dir) => assembledAssetsError(dir, www(dir), { exact: true });

/** Every file under `dir`, relative and sorted. */
function tree(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

test('remote mode: www holds only the shell, under meroshell/, plus the manifest', () => {
  const dir = starterRoot();
  const result = prepareWeb({ rootDir: dir });
  assert.equal(result.mode, 'remote');
  assert.deepEqual(tree(www(dir)), [MANIFEST, 'meroshell/index.html', 'meroshell/js/controller.js', 'meroshell/shell.css'].sort());
  for (const [name, text] of Object.entries(SHELL)) {
    assert.equal(read(www(dir), `meroshell/${name}`), text);
  }
  assert.equal(exists(www(dir), 'index.html'), false, 'no site at the www root in remote mode');
  assert.equal(fresh(dir), null);
});

test('bundled mode: the already-built site is copied unchanged to the www root beside meroshell/', () => {
  const dir = starterRoot(BUNDLED);
  const before = tree(path.join(dir, 'site'));
  const result = prepareWeb({ rootDir: dir });
  assert.equal(result.mode, 'bundled');
  for (const [name, text] of Object.entries(SITE)) {
    assert.equal(read(www(dir), name), text);
  }
  for (const [name, text] of Object.entries(SHELL)) {
    assert.equal(read(www(dir), `meroshell/${name}`), text);
  }
  assert.deepEqual(tree(path.join(dir, 'site')), before, 'the site is read, never written');
  assert.deepEqual(tree(www(dir)).filter((f) => !f.startsWith('meroshell/')), Object.keys(SITE).sort());
  assert.equal(fresh(dir), null);
});

test('a site outside the starter root is assembled the same way', () => {
  const parent = tempDir('meroshell-parent-');
  const dir = path.join(parent, 'starter');
  fs.mkdirSync(dir);
  write(dir, { 'starter.config.json': JSON.stringify({ ...STARTER, mode: 'bundled', site: '../web/dist' }), 'package.json': '{"version":"1.0.0"}' });
  write(path.join(dir, 'shell'), SHELL);
  write(path.join(parent, 'web', 'dist'), SITE);
  prepareWeb({ rootDir: dir });
  assert.equal(read(www(dir), 'assets/app.js'), 'app()');
});

test('reassembly replaces www entirely: leftovers and a previous mode disappear', () => {
  const dir = starterRoot(BUNDLED);
  prepareWeb({ rootDir: dir });
  write(www(dir), { 'leftover.txt': 'x' });
  fs.writeFileSync(path.join(dir, 'starter.config.json'), JSON.stringify(STARTER));
  prepareWeb({ rootDir: dir });
  assert.equal(exists(www(dir), 'leftover.txt'), false);
  assert.equal(exists(www(dir), 'index.html'), false);
  assert.equal(fresh(dir), null);
});

test('the meroshell namespace is reserved: a site that uses it fails clearly and www is left alone', () => {
  for (const collision of [{ 'meroshell/index.html': 'x' }, { meroshell: 'a file' }, { 'MeroShell/app.js': 'x' }]) {
    const dir = starterRoot(BUNDLED, { site: { ...SITE, ...collision } });
    write(www(dir), { 'previous.txt': 'kept' });
    assert.throws(
      () => prepareWeb({ rootDir: dir }),
      (error) => error instanceof WebAssetsError && /reserved/.test(error.message) && /meroshell/i.test(error.message),
    );
    assert.equal(read(www(dir), 'previous.txt'), 'kept');
  }
});

test('an invalid configuration or a missing site fails before www is touched', () => {
  const dir = starterRoot(BUNDLED);
  fs.rmSync(path.join(dir, 'site'), { recursive: true });
  assert.throws(() => prepareWeb({ rootDir: dir }), ShellConfigError);
  assert.equal(exists(dir, 'www'), false);
});

test('freshness: missing www, missing or corrupt manifest are reported', () => {
  const dir = starterRoot();
  assert.match(fresh(dir), /no assembled web assets/);
  prepareWeb({ rootDir: dir });
  fs.writeFileSync(path.join(www(dir), MANIFEST), '{');
  assert.match(fresh(dir), /not valid JSON/);
  fs.rmSync(path.join(www(dir), MANIFEST));
  assert.match(fresh(dir), /no assembled web assets/);
});

/** Run `change` on a freshly assembled fixture, restoring the edited file's timestamps. */
function staleAfter(starter, change) {
  const dir = starterRoot(starter);
  prepareWeb({ rootDir: dir });
  assert.equal(fresh(dir), null);
  change(dir);
  return fresh(dir);
}

/** Write `text` to an existing file and put its modification time back, so only content differs. */
function editKeepingTime(file, text) {
  const { atime, mtime } = fs.statSync(file);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, atime, mtime);
}

test('freshness: configuration changes are detected', () => {
  assert.match(staleAfter(STARTER, (dir) => {
    write(path.join(dir, 'site'), SITE);
    fs.writeFileSync(path.join(dir, 'starter.config.json'), JSON.stringify(BUNDLED));
  }), /mode/);
  assert.match(staleAfter(BUNDLED, (dir) => {
    fs.writeFileSync(path.join(dir, 'starter.config.json'), JSON.stringify(STARTER));
  }), /mode/);
  assert.match(staleAfter(BUNDLED, (dir) => {
    fs.cpSync(path.join(dir, 'site'), path.join(dir, 'other'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'starter.config.json'), JSON.stringify({ ...BUNDLED, site: 'other' }));
  }), /site/);
});

test('freshness: nested shell edits, additions and deletions are detected without relying on timestamps', () => {
  assert.match(staleAfter(STARTER, (dir) => editKeepingTime(path.join(dir, 'shell', 'js', 'controller.js'), 'changed()')), /meroshell\/js\/controller\.js changed/);
  assert.match(staleAfter(STARTER, (dir) => write(path.join(dir, 'shell'), { 'js/deep/new.js': 'x' })), /meroshell\/js\/deep\/new\.js added/);
  assert.match(staleAfter(STARTER, (dir) => fs.rmSync(path.join(dir, 'shell', 'js', 'controller.js'))), /meroshell\/js\/controller\.js removed/);
});

test('freshness: nested site edits, additions and deletions are detected without relying on timestamps', () => {
  assert.match(staleAfter(BUNDLED, (dir) => editKeepingTime(path.join(dir, 'site', 'assets', 'img', 'logo.svg'), '<svg id="2"/>')), /assets\/img\/logo\.svg changed/);
  assert.match(staleAfter(BUNDLED, (dir) => write(path.join(dir, 'site'), { 'assets/img/new.png': 'png' })), /assets\/img\/new\.png added/);
  assert.match(staleAfter(BUNDLED, (dir) => fs.rmSync(path.join(dir, 'site', 'assets', 'app.js'))), /assets\/app\.js removed/);
});

test('freshness: an assembled directory edited by hand no longer matches its manifest', () => {
  assert.match(staleAfter(BUNDLED, (dir) => editKeepingTime(path.join(www(dir), 'assets', 'app.js'), 'tampered()')), /assets\/app\.js changed/);
  assert.match(staleAfter(BUNDLED, (dir) => fs.rmSync(path.join(www(dir), 'meroshell', 'shell.css'))), /meroshell\/shell\.css removed/);
  assert.match(staleAfter(BUNDLED, (dir) => write(www(dir), { 'extra.js': 'x' })), /extra\.js added/);
});

test('freshness of a copy ignores files Capacitor adds when exact is off, but not changed files', () => {
  const dir = starterRoot(BUNDLED);
  prepareWeb({ rootDir: dir });
  const copy = path.join(dir, 'public');
  fs.cpSync(www(dir), copy, { recursive: true });
  write(copy, { 'cordova.js': '', 'cordova_plugins.js': '' });
  assert.equal(assembledAssetsError(dir, copy, { exact: false }), null);
  assert.match(assembledAssetsError(dir, copy, { exact: true }), /cordova\.js added/);
  editKeepingTime(path.join(copy, 'meroshell', 'index.html'), 'old');
  assert.match(assembledAssetsError(dir, copy, { exact: false }), /meroshell\/index\.html changed/);
});

test('npm run web runs scripts/prepare-web.cjs, which assembles www or exits 1 with the reason', () => {
  const pkg = JSON.parse(read(ROOT, 'package.json'));
  assert.equal(pkg.scripts.web, 'node scripts/prepare-web.cjs');
  const dir = starterRoot(BUNDLED);
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'prepare-web.cjs'), path.join(dir, 'scripts', 'prepare-web.cjs'));
  for (const lib of ['web-assets.cjs', 'shell-config.cjs']) {
    fs.copyFileSync(path.join(ROOT, 'lib', lib), path.join(dir, 'lib', lib));
  }
  const ok = spawnSync(process.execPath, ['scripts/prepare-web.cjs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /prepare-web: assembled www\/ \(bundled, \d+ files\)/);
  assert.equal(read(www(dir), 'index.html'), SITE['index.html']);
  write(path.join(dir, 'site'), { 'meroshell/x.js': 'x' });
  const collided = spawnSync(process.execPath, ['scripts/prepare-web.cjs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(collided.status, 1);
  assert.match(collided.stderr, /prepare-web: .*reserved/);
});

test('every Capacitor copy and sync reassembles www first through the copy hook', () => {
  const pkg = JSON.parse(read(ROOT, 'package.json'));
  assert.equal(pkg.scripts['capacitor:copy:before'], 'node scripts/prepare-web.cjs');
});

test('www is generated and git-ignored', (t) => {
  const ignore = read(ROOT, '.gitignore').split('\n').map((line) => line.trim());
  assert.ok(ignore.includes('/www/'));
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git is not installed');
    return;
  }
  const dir = tempDir('meroshell-ignore-');
  fs.copyFileSync(path.join(ROOT, '.gitignore'), path.join(dir, '.gitignore'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const ignored = spawnSync('git', ['check-ignore', '--no-index', 'www/meroshell/index.html', 'www/index.html'], { cwd: dir, encoding: 'utf8' });
  assert.deepEqual(ignored.stdout.trim().split('\n'), ['www/meroshell/index.html', 'www/index.html']);
});
