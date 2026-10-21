#!/usr/bin/env node
'use strict';

/*
 * npm run ios:prepare
 * Run after `npx cap add ios` and `npx cap sync ios`. Applies the Face ID usage text, display
 * name, bundle identifier, associated domains and the Release build guard to the generated
 * project. Safe to run again.
 */

const path = require('node:path');
const { prepareIosProject } = require('../lib/ios-project.cjs');

try {
  const changed = prepareIosProject({ rootDir: path.join(__dirname, '..') });
  console.log(changed.length > 0 ? `prepare-ios: updated ${changed.join(', ')}` : 'prepare-ios: already prepared');
} catch (error) {
  console.error(`prepare-ios: ${error.message}`);
  process.exit(1);
}
