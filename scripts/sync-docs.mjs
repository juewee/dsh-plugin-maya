#!/usr/bin/env node
/**
 * Sync the offline Maya command documentation into this plugin.
 *
 * Source: a checkout of the `maya-doc` project, whose Trae skills carry the
 * scraped Autodesk data:
 *   <maya-doc>/.trae/skills/maya-<version>-api-doc/data/{index.json,maya_commands_python.json}
 *
 * Usage:
 *   node scripts/sync-docs.mjs [--from <maya-doc checkout>] [--to <plugin data dir>]
 */
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { from: resolve(PLUGIN_ROOT, '..', 'maya-doc'), to: join(PLUGIN_ROOT, 'data') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from') options.from = resolve(argv[++i]);
    else if (argv[i] === '--to') options.to = resolve(argv[++i]);
  }
  return options;
}

async function main() {
  const { from, to } = parseArgs(process.argv.slice(2));
  const skillsRoot = join(from, '.trae', 'skills');
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    throw new Error('no maya-doc skills at ' + skillsRoot + ' — pass --from <maya-doc checkout>');
  }
  await mkdir(to, { recursive: true });
  const manifest = { source: from, syncedAt: new Date().toISOString(), versions: [] };
  for (const entry of entries) {
    const match = /^maya-(\d{4})-api-doc$/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const version = match[1];
    const source = join(skillsRoot, entry.name, 'data');
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
  if (manifest.versions.length === 0) throw new Error('no maya-<version>-api-doc skills found under ' + skillsRoot);
  await writeFile(join(to, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('wrote ' + join(to, 'MANIFEST.json'));
}

main().catch((error) => {
  console.error('sync-docs failed: ' + error.message);
  process.exitCode = 1;
});
