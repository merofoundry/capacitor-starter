'use strict';

/**
 * App artwork. The repository holds two source images, assets/icon.png and
 * assets/splash.png; this derives the inputs @capacitor/assets expects from them. The
 * generated platform artwork is never committed.
 */

const fs = require('node:fs');
const path = require('node:path');

const ICON_SIZE = 1024;
const SPLASH_SIZE = 2732;
const FOREGROUND_SCALE = 0.9;
const NATIVE_PROJECTS = {
  android: { dir: 'android', hint: 'android/ is committed; restore it from the repository' },
  ios: { dir: path.join('ios', 'App'), hint: 'run npx cap add ios first' },
};

class AssetError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AssetError';
  }
}

function loadSharp() {
  return require('sharp');
}

/**
 * @param {string} file
 * @param {number} minimum
 * @param {string} label
 */
async function requireSquare(file, minimum, label) {
  if (!fs.existsSync(file)) {
    throw new AssetError(`missing ${label} source ${file}`);
  }
  const { width, height } = await loadSharp()(file).metadata();
  if (width !== height || width < minimum) {
    throw new AssetError(`${label} source ${file} must be a square of at least ${minimum}px, found ${width}x${height}`);
  }
}

/**
 * Write icon-only, icon-foreground, icon-background, splash and splash-dark into outDir.
 * @param {{rootDir: string, outDir: string}} options
 * @returns {Promise<string[]>} the files written
 */
async function deriveAssetInputs({ rootDir, outDir }) {
  const sharp = loadSharp();
  const icon = path.join(rootDir, 'assets', 'icon.png');
  const splash = path.join(rootDir, 'assets', 'splash.png');
  await requireSquare(icon, ICON_SIZE, 'icon');
  await requireSquare(splash, SPLASH_SIZE, 'splash');

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const [r, g, b] = await sharp(icon).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  const background = { r, g, b };
  const foregroundSize = Math.round(ICON_SIZE * FOREGROUND_SCALE);
  const margin = Math.floor((ICON_SIZE - foregroundSize) / 2);
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

  const outputs = {
    'icon-only.png': sharp(icon).resize(ICON_SIZE, ICON_SIZE).flatten({ background }).removeAlpha(),
    'icon-background.png': sharp({ create: { width: ICON_SIZE, height: ICON_SIZE, channels: 3, background } }),
    'icon-foreground.png': sharp(icon)
      .resize(foregroundSize, foregroundSize)
      .ensureAlpha()
      .extend({ top: margin, left: margin, bottom: ICON_SIZE - foregroundSize - margin, right: ICON_SIZE - foregroundSize - margin, background: transparent }),
    'splash.png': sharp(splash).resize(SPLASH_SIZE, SPLASH_SIZE, { fit: 'cover' }),
    'splash-dark.png': sharp(splash).resize(SPLASH_SIZE, SPLASH_SIZE, { fit: 'cover' }),
  };
  const written = [];
  for (const [name, image] of Object.entries(outputs)) {
    const file = path.join(outDir, name);
    await image.png().toFile(file);
    written.push(file);
  }
  return written;
}

/**
 * @param {string} rootDir
 * @param {string[]} platforms
 */
function requireNativeProjects(rootDir, platforms) {
  for (const platform of platforms) {
    const project = NATIVE_PROJECTS[platform];
    if (!project) {
      throw new AssetError(`unknown platform ${platform}`);
    }
    if (!fs.existsSync(path.join(rootDir, project.dir))) {
      throw new AssetError(`no ${platform} native project at ${project.dir}: ${project.hint}`);
    }
  }
}

/**
 * @param {string} assetPath
 * @param {string[]} platforms
 * @returns {string[]}
 */
function generatorArgs(assetPath, platforms) {
  return ['generate', '--assetPath', assetPath, ...platforms.map((p) => `--${p}`)];
}

module.exports = { AssetError, deriveAssetInputs, generatorArgs, requireNativeProjects };
