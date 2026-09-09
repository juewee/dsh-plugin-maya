#!/usr/bin/env node
/**
 * Install this plugin's skills into a DSH skill root so the model's catalog
 * picks them up without any plugin installation.
 *
 * Default target: <project>/.dsh/skills (the rank-100 project root that
 * `@deepseek-ai/dsh-skill-filesystem` scans; the project root is the nearest
 * ancestor containing .git, otherwise the current directory).
 *
 * Usage:
 *   node scripts/install-skills.mjs [--to <skills dir>]
 */
import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function target() {
  const flag = process.argv.indexOf('--to');
  if (flag !== -1) return resolve(process.argv[flag + 1]);
  return join(resolve(PLUGIN_ROOT, '..'), '.dsh', 'skills');
}

const to = target();
await mkdir(to, { recursive: true });
const entries = await readdir(join(PLUGIN_ROOT, 'skills'), { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  await cp(join(PLUGIN_ROOT, 'skills', entry.name), join(to, entry.name), { recursive: true, force: true });
  console.log('installed skill ' + entry.name + ' -> ' + join(to, entry.name));
}
console.log('done: ' + entries.filter((e) => e.isDirectory()).length + ' skill(s) in ' + to);
