#!/usr/bin/env node
/**
 * Dev helper: point this plugin's `node_modules` at a DSH installation so the
 * test harness (and an optional official `@deepseek-ai/dsh-tools` import) can
 * resolve `@deepseek-ai/cordis`, `dsh-tools` and `dsh-system-prompt`.
 *
 * The plugin itself imports nothing but Node builtins, so this link is ONLY
 * needed to run `test/smoke.mjs`; the plugin runs without it.
 *
 * Usage:
 *   node scripts/link-dsh-modules.mjs [--modules <path to node_modules>]
 */
import { createRequire } from 'node:module';
import { existsSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findModules() {
  const explicit = process.argv.indexOf('--modules');
  if (explicit !== -1) return resolve(process.argv[explicit + 1]);
  const candidates = [];
  try {
    const require = createRequire(import.meta.url);
    candidates.push(join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), '..', '..'));
  } catch { /* dsh not resolvable from here */ }
  candidates.push(join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'profiles', 'web', 'node_modules'));
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, '@deepseek-ai', 'dsh-tools'))) return candidate;
  }
  throw new Error('could not locate a DSH node_modules — pass --modules <path>');
}

const modules = findModules();
const link = join(PLUGIN_ROOT, 'node_modules');
if (existsSync(link)) {
  console.log('already linked: ' + link);
} else {
  symlinkSync(modules, link, 'junction');
  console.log('linked ' + link + ' -> ' + modules);
}
