#!/usr/bin/env node
/**
 * Open a Maya scene in a persistent headless session and print its Outliner tree.
 *
 * This uses the plugin's modules directly (no DSH host needed), which is also a
 * convenient way to sanity-check a Maya install:
 *
 *   node examples/walk-scene.mjs "D:/path/to/scene.ma"
 *   node examples/walk-scene.mjs scene.mb --depth 4 --nodes 60
 *
 * It opens the file read-only: nothing is written back, and the user's running
 * Maya (if any) is untouched.
 */
import { MayaSession } from '../lib/session.js';
import { detectMayapy, ensurePrefsDir } from '../lib/standalone.js';

const args = process.argv.slice(2);
const scene = args.find((item) => !item.startsWith('--'));
const flag = (name, fallback) => {
  const index = args.indexOf('--' + name);
  return index === -1 ? fallback : Number(args[index + 1]);
};
if (!scene) {
  console.error('usage: node examples/walk-scene.mjs <scene.ma|scene.mb> [--depth N] [--nodes N]');
  process.exit(1);
}

const mayapy = await detectMayapy(null);
if (!mayapy) {
  console.error('mayapy.exe not found — install Maya or set DSH_MAYA_MAYAPY');
  process.exit(1);
}

const session = new MayaSession();
try {
  const started = await session.start({ mayapy, cleanPrefs: true, prefsDir: await ensurePrefsDir() });
  console.log('session: pid ' + started.pid + ' | mayapy ' + started.mayapy);
  console.log('python: ' + started.python + ' | prefs: isolated');

  const result = await session.run(
    [
      'import maya.cmds as cmds',
      'cmds.file(new=True, force=True)',
      'scene_path = ' + JSON.stringify(scene),
      'cmds.file(scene_path, open=True, force=True)',
      'print("scene:", cmds.file(query=True, sceneName=True))',
      'print("nodes:", len(cmds.ls()), "| meshes:", len(cmds.ls(type="mesh")), "| joints:", len(cmds.ls(type="joint")))',
      'print("references:", len(cmds.file(query=True, reference=True) or []))',
      '',
      'def walk(node, depth=0, max_depth=3, seen=None):',
      '    if depth > max_depth:',
      '        return',
      '    print("  " * depth + "- " + node + " [" + cmds.nodeType(node) + "]")',
      '    for child in cmds.listRelatives(node, children=True, fullPath=False) or []:',
      '        walk(child, depth + 1, max_depth, seen)',
      '',
      'roots = cmds.ls(assemblies=True)',
      'print("root assemblies:", len(roots))',
      'for root in roots[:40]:',
      '    walk(root, 0, ' + String(flag('depth', 2)) + ')',
      'print("top-level transforms:", cmds.ls(type="transform", assemblies=True)[:20])',
    ].join('\n'),
    { timeoutMs: 300000 },
  );

  if (result.stdout) console.log(result.stdout.trimEnd());
  if (result.stderr) console.log('--- stderr ---\n' + result.stderr.trimEnd());
  if (result.error) console.log('--- traceback ---\n' + result.error.trimEnd());
  process.exitCode = result.ok ? 0 : 1;
} finally {
  await session.stop();
}
