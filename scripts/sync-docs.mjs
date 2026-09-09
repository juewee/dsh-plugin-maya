#!/usr/bin/env node
/**
 * Sync the offline Maya command documentation into this plugin.
 *
 * Source: a checkout of the `maya-doc` project, which stores the scraped
 * Autodesk data in one directory per version:
 *
 *   <checkout>/.../maya-<version>-api-doc/data/{index.json,maya_commands_python.json}
 *
 * The directories are located by name wherever they sit in the checkout, so the
 * script does not depend on the source project's folder layout.
 *
 * Usage:
 *   node scripts/sync-docs.mjs [--from <maya-doc checkout>] [--to <plugin data dir>]
 */
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_DIR = /^maya-(\d{4})-api-doc$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build']);

function parseArgs(argv) {
  const options = { from: resolve(PLUGIN_ROOT, '..', 'maya-doc'), to: join(PLUGIN_ROOT, 'data') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from') options.from = resolve(argv[++i]);
    else if (argv[i] === '--to') options.to = resolve(argv[++i]);
  }
  return options;
}

/** Find every `maya-<version>-api-doc` directory under `root` (breadth-first, depth-capped). */
async function findVersionDirs(root, maxDepth = 6) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (VERSION_DIR.test(entry.name)) found.push(full);
      else queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return found;
}

async function main() {
  const { from, to } = parseArgs(process.argv.slice(2));
  const versionDirs = await findVersionDirs(from);
  if (versionDirs.length === 0) {
    throw new Error('no maya-<version>-api-doc directories found under ' + from + ' — pass --from <maya-doc checkout>');
  }
  await mkdir(to, { recursive: true });
  const manifest = { source: from, syncedAt: new Date().toISOString(), versions: [] };

  for (const versionDir of versionDirs.sort()) {
    const version = VERSION_DIR.exec(basename(versionDir))[1];
    const source = join(versionDir, 'data');
    const target = join(to, version);
    await mkdir(target, { recursive: true });
    for (const file of ['index.json', 'maya_commands_python.json']) {
      await cp(join(source, file), join(target, file), { force: true });
    }
    const commands = JSON.parse(await readFile(join(target, 'maya_commands_python.json'), 'utf8'));
    const index = JSON.parse(await readFile(join(target, 'index.json'), 'utf8'));
    const bytes = (await stat(join(target, 'maya_commands_python.json'))).size;
    manifest.versions.push({ version, commands: commands.commands?.length ?? 0, indexed: Object.keys(index).length, bytes });
    console.log('synced Maya ' + version + ': ' + (commands.commands?.length ?? 0) + ' commands (' + Math.round(bytes / 1024) + ' KiB)');
  }

  manifest.versions.sort((a, b) => a.version.localeCompare(b.version));
  await writeFile(join(to, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('wrote ' + join(to, 'MANIFEST.json'));
}

main().catch((error) => {
  console.error('sync-docs failed: ' + error.message);
  process.exitCode = 1;
});
