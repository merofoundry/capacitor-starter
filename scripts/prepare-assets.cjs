#!/usr/bin/env node
'use strict';

/*
 * npm run assets -- [--ios] [--android]
 * Derives the @capacitor/assets inputs from assets/icon.png and assets/splash.png into
 * .assets-build/ and generates icons and splash screens into the existing native projects.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { AssetError, deriveAssetInputs, generatorArgs, requireNativeProjects } = require('../lib/assets.cjs');

const ROOT = path.join(__dirname, '..');
// @capacitor/assets joins --assetPath onto the project root, so it must stay relative.
const DERIVED = '.assets-build';

async function main(argv) {
  const platforms = ['ios', 'android'].filter((p) => argv.includes(`--${p}`));
  if (platforms.length === 0) {
    throw new AssetError('name the platforms to generate for: --ios, --android or both');
  }
  requireNativeProjects(ROOT, platforms);
  await deriveAssetInputs({ rootDir: ROOT, outDir: path.join(ROOT, DERIVED) });
  const bin = path.join(path.dirname(require.resolve('@capacitor/assets/package.json')), 'bin', 'capacitor-assets');
  const run = spawnSync(process.execPath, [bin, ...generatorArgs(DERIVED, platforms)], { cwd: ROOT, stdio: 'inherit' });
  if (run.status !== 0) {
    throw new AssetError(`@capacitor/assets failed with status ${run.status}`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`prepare-assets: ${error.message}`);
  process.exit(1);
});
