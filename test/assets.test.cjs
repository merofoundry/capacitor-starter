'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const { AssetError, deriveAssetInputs, requireNativeProjects, generatorArgs } = require('../lib/assets.cjs');
const { tempDir } = require('./helpers/temp.cjs');

const ROOT = path.join(__dirname, '..');

function tmp() {
  return tempDir('meroshell-assets-');
}

test('the inputs @capacitor/assets expects are derived from the two committed images', async () => {
  const out = path.join(tmp(), 'derived');
  const written = await deriveAssetInputs({ rootDir: ROOT, outDir: out });
  assert.deepEqual(
    written.map((f) => path.basename(f)).sort(),
    ['icon-background.png', 'icon-foreground.png', 'icon-only.png', 'splash-dark.png', 'splash.png'],
  );
  const meta = async (name) => sharp(path.join(out, name)).metadata();
  for (const name of ['icon-only.png', 'icon-foreground.png', 'icon-background.png']) {
    const m = await meta(name);
    assert.equal(m.width, 1024, name);
    assert.equal(m.height, 1024, name);
  }
  assert.equal((await meta('icon-only.png')).hasAlpha, false, 'App Store icons may not have transparency');
  assert.equal((await meta('icon-foreground.png')).hasAlpha, true, 'the adaptive foreground is transparent around the icon');
  for (const name of ['splash.png', 'splash-dark.png']) {
    const m = await meta(name);
    assert.equal(m.width, 2732, name);
    assert.equal(m.height, 2732, name);
  }
});

test('the adaptive icon background is the committed icon’s edge colour', async () => {
  const out = path.join(tmp(), 'derived');
  await deriveAssetInputs({ rootDir: ROOT, outDir: out });
  const corner = await sharp(path.join(ROOT, 'assets', 'icon.png')).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  const stats = await sharp(path.join(out, 'icon-background.png')).stats();
  assert.deepEqual(stats.channels.slice(0, 3).map((c) => [c.min, c.max]), [...corner].map((v) => [v, v]));
});

test('derivation replaces a previous output directory instead of mixing old files in', async () => {
  const out = path.join(tmp(), 'derived');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'logo.png'), 'stale');
  await deriveAssetInputs({ rootDir: ROOT, outDir: out });
  assert.equal(fs.existsSync(path.join(out, 'logo.png')), false);
});

async function fixtureWith(iconSize, splashSize) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'assets'));
  const solid = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#123456' } }).png();
  await solid(...iconSize).toFile(path.join(dir, 'assets', 'icon.png'));
  await solid(...splashSize).toFile(path.join(dir, 'assets', 'splash.png'));
  return dir;
}

test('a source icon that is not a square of at least 1024 pixels is rejected', async () => {
  for (const size of [[1024, 900], [512, 512]]) {
    const dir = await fixtureWith(size, [2732, 2732]);
    await assert.rejects(deriveAssetInputs({ rootDir: dir, outDir: path.join(dir, 'out') }), AssetError);
  }
});

test('a source splash that is not a square of at least 2732 pixels is rejected', async () => {
  const dir = await fixtureWith([1024, 1024], [2048, 2048]);
  await assert.rejects(deriveAssetInputs({ rootDir: dir, outDir: path.join(dir, 'out') }), /splash/);
});

test('assets are generated only into native projects that already exist', () => {
  const dir = tmp();
  assert.throws(() => requireNativeProjects(dir, ['ios']), /npx cap add ios/);
  assert.throws(() => requireNativeProjects(dir, ['android']), /android/);
  fs.mkdirSync(path.join(dir, 'ios', 'App'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'android'));
  assert.doesNotThrow(() => requireNativeProjects(dir, ['ios', 'android']));
});

test('the generator is pointed at the derived inputs and the requested platforms only', () => {
  assert.deepEqual(generatorArgs('/x/.assets-build', ['android']), ['generate', '--assetPath', '/x/.assets-build', '--android']);
  assert.deepEqual(generatorArgs('/x/.assets-build', ['ios', 'android']), ['generate', '--assetPath', '/x/.assets-build', '--ios', '--android']);
});
