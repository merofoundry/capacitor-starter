#!/usr/bin/env node
'use strict';

/*
 * node scripts/release-guard.cjs --platform <android|ios> --stage <workflow|package>
 * Exits 1 when a release must not proceed, 2 on bad arguments. Run by both release
 * workflows before sync, by the Android release pre-build task and by the Xcode Release
 * build phase that scripts/prepare-ios.cjs installs.
 */

const path = require('node:path');
const { PLATFORMS, STAGES, checkRelease } = require('../lib/release-guard.cjs');

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);
const platform = option(argv, 'platform');
const stage = option(argv, 'stage');
if (!PLATFORMS.includes(platform) || !STAGES.includes(stage)) {
  console.error(`usage: release-guard --platform <${PLATFORMS.join('|')}> --stage <${STAGES.join('|')}>`);
  process.exit(2);
}

const errors = checkRelease({ rootDir: path.join(__dirname, '..'), env: process.env, platform, stage });
if (errors.length > 0) {
  for (const error of errors) {
    console.error(`release-guard (${platform}, ${stage}): ${error}`);
  }
  process.exit(1);
}
console.log(`release-guard (${platform}, ${stage}): production configuration confirmed`);
