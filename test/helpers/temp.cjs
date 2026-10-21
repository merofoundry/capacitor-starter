'use strict';

/** Temporary directories that are removed when the test file finishes. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after } = require('node:test');

const created = [];

after(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @param {string} prefix
 * @returns {string}
 */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

module.exports = { tempDir };
