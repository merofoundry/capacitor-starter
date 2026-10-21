import type { CapacitorConfig } from '@capacitor/cli';

// The shell's configuration lives in starter.config.json. Set MEROSHELL_PREVIEW_HOST to sync a
// debug build against the preview host; both release workflows and the native release builds
// refuse a project synced that way.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadCapacitorConfig } = require('./lib/shell-config.cjs');

const config: CapacitorConfig = loadCapacitorConfig({ rootDir: __dirname, env: process.env });

export default config;
