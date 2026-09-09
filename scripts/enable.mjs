#!/usr/bin/env node
/**
 * Enable dsh-plugin-maya in a DSH profile by appending one insert row to the
 * profile's user patch layer (`cordis.patch.yml`). With `patchReload: live`
 * (the default for the web profile) the row hot-loads into the running GUI —
 * no restart needed.
 *
 * The plugin is referenced by `file://` URL, so no pnpm install is required.
 *
 * Usage:
 *   node scripts/enable.mjs [--profile web] [--dry-run]
 *                          [--docs-root <dir>] [--mayapy <path>] [--port 6000]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ENTRY = join(PLUGIN_ROOT, 'lib', 'index.js');
const MARKER = 'dsh-plugin-maya';

function flag(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index === -1 ? fallback : process.argv[index + 1];
}
function slash(value) {
  return value.replace(/\\/g, '/');
}

const dryRun = process.argv.includes('--dry-run');
const profile = flag('profile', 'web');
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const profileDir = join(home, 'profiles', profile);
const patchFile = join(profileDir, 'cordis.patch.yml');

if (!existsSync(profileDir)) throw new Error('no such profile directory: ' + profileDir);
if (!existsSync(PLUGIN_ENTRY)) throw new Error('plugin entry missing: ' + PLUGIN_ENTRY);

const config = {
  docsRoot: flag('docs-root', join(PLUGIN_ROOT, 'data')),
  defaultVersion: flag('version', '2025'),
  mayapy: flag('mayapy', join('D:', 'losheep', 'tools', 'Maya', 'Maya2025', 'bin', 'mayapy.exe')),
  commandPortPort: Number(flag('port', '6000')),
  debugLogPath: join(resolve(PLUGIN_ROOT, '..'), '.dsh', 'maya-plugin.log'),
};

const row = [
  '- insert:',
  '    - id: maya',
  "      name: '" + pathToFileURL(PLUGIN_ENTRY).href + "'",
  '      config:',
  "        docsRoot: '" + slash(config.docsRoot) + "'",
  "        defaultVersion: '" + config.defaultVersion + "'",
  "        mayapy: '" + slash(config.mayapy) + "'",
  '        commandPortPort: ' + config.commandPortPort,
  "        debugLogPath: '" + slash(config.debugLogPath) + "'",
].join('\n');

const existing = existsSync(patchFile) ? await readFile(patchFile, 'utf8') : '';
if (existing.includes(MARKER)) {
  console.log('already enabled in ' + patchFile);
} else {
  const trimmed = existing.trim();
  let next;
  if (trimmed === '') next = row + '\n';
  else if (trimmed.endsWith('[]')) next = existing.replace(/\[\]\s*$/, row + '\n');
  else next = existing.replace(/\s*$/, '') + '\n\n' + row + '\n';
  if (dryRun) {
    console.log('--- would write ' + patchFile + ' ---');
    console.log(next);
  } else {
    await writeFile(patchFile, next, 'utf8');
    console.log('wrote ' + patchFile);
  }
}
console.log('plugin entry: ' + pathToFileURL(PLUGIN_ENTRY).href);
