#!/usr/bin/env node
'use strict';

/*
 * npm run web
 * Assembles www/, the directory Capacitor packages: the shell screens under www/meroshell/
 * and, in bundled mode, your already-built site at the www/ root. Run it before every
 * `npx cap sync`; the copy hook in package.json also runs it on every Capacitor copy.
 */

const path = require('node:path');
const { prepareWeb } = require('../lib/web-assets.cjs');

try {
  const { mode, files } = prepareWeb({ rootDir: path.join(__dirname, '..') });
  console.log(`prepare-web: assembled www/ (${mode}, ${files} files)`);
} catch (error) {
  console.error(`prepare-web: ${error.message}`);
  process.exit(1);
}
