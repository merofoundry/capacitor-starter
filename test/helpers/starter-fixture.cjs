'use strict';

/**
 * Disposable copies of the starter for fixture tests that run the real Capacitor CLI
 * (`cap add ios`, `cap sync`). The copy shares this checkout's node_modules through a
 * symlink; nothing is built, signed or uploaded.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./temp.cjs');

const ROOT = path.join(__dirname, '..', '..');
const COPIED = ['package.json', 'capacitor.config.ts', 'lib', 'scripts', 'shell', 'native', 'assets'];
const CLI = path.join(ROOT, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');

/**
 * @param {{starter?: object, withAndroid?: boolean}} [options]
 * @returns {string} the fixture root
 */
function starterCopy({ starter, withAndroid = false } = {}) {
  const dir = tempDir('meroshell-starter-');
  for (const entry of COPIED) {
    fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  if (withAndroid) {
    fs.cpSync(path.join(ROOT, 'android'), path.join(dir, 'android'), {
      recursive: true,
      filter: (src) => !/[\\/](build|\.gradle)([\\/]|$)/.test(path.relative(ROOT, src)),
    });
  }
  const config = starter || JSON.parse(fs.readFileSync(path.join(ROOT, 'starter.config.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'starter.config.json'), JSON.stringify(config, null, 2) + '\n');
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

/**
 * Run the Capacitor CLI in `dir`.
 * @param {string} dir
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function cap(dir, args, env = {}) {
  const baseEnv = { ...process.env, CI: '1', CAPACITOR_TELEMETRY: 'false' };
  delete baseEnv.MEROSHELL_PREVIEW_HOST;
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { ...baseEnv, ...env }, encoding: 'utf8' });
  if (run.status !== 0) {
    throw new Error(`cap ${args.join(' ')} failed (${run.status}):\n${run.stdout}\n${run.stderr}`);
  }
  return run;
}

/** Run a starter script with node in `dir`. */
function node(dir, args, env = {}) {
  const baseEnv = { ...process.env };
  delete baseEnv.MEROSHELL_PREVIEW_HOST;
  return spawnSync(process.execPath, args, { cwd: dir, env: { ...baseEnv, ...env }, encoding: 'utf8' });
}

module.exports = { ROOT, cap, node, starterCopy };
