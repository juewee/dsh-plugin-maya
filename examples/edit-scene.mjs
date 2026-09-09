#!/usr/bin/env node
/**
 * Open a Maya scene headlessly, make a small edit, and save the result to a NEW
 * file — the input is never modified.
 *
 *   node examples/edit-scene.mjs input.ma output.ma [--group ORGANIZE_GRP]
 *
 * Useful as a template for batch scene processing: open, inspect, modify,
 * export, verify.
 */
import { MayaSession } from '../lib/session.js';
import { detectMayapy, ensurePrefsDir } from '../lib/standalone.js';

const args = process.argv.slice(2);
const positional = args.filter((item) => !item.startsWith('--'));
const [input, output] = positional;
const groupIndex = args.indexOf('--group');
const groupName = groupIndex === -1 ? 'DSH_ORGANIZED' : args[groupIndex + 1];

if (!input || !output) {
  console.error('usage: node examples/edit-scene.mjs <input.ma|mb> <output.ma|mb> [--group NAME]');
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
  console.log('session: pid ' + started.pid + ' | python ' + started.python + ' | prefs isolated');

  const result = await session.run(
    [
      'import maya.cmds as cmds',
      'input_path = ' + JSON.stringify(input),
      'output_path = ' + JSON.stringify(output),
      'group_name = ' + JSON.stringify(groupName),
      '',
      'cmds.file(new=True, force=True)',
      'cmds.file(input_path, open=True, force=True)',
      'before = len(cmds.ls())',
      'print("opened:", cmds.file(query=True, sceneName=True))',
      'print("nodes before:", before, "| meshes:", len(cmds.ls(type="mesh")))',
      '',
      'meshes = cmds.listRelatives(cmds.ls(type="mesh"), parent=True, fullPath=False) or []',
      'meshes = list(dict.fromkeys(meshes))',
      'if cmds.objExists(group_name):',
      '    group = group_name',
      'elif meshes:',
      '    group = cmds.group(meshes, name=group_name)',
      '    print("grouped", len(meshes), "mesh transforms under", group)',
      'else:',
      '    group = cmds.group(empty=True, name=group_name)',
      '    print("no meshes found; created empty group", group)',
      '',
      'cmds.file(rename=output_path)',
      'cmds.file(save=True, type="mayaAscii")',
      'print("saved:", cmds.file(query=True, sceneName=True))',
      '',
      'cmds.file(new=True, force=True)',
      'cmds.file(output_path, open=True, force=True)',
      'print("reopened:", cmds.file(query=True, sceneName=True))',
      'print("nodes after:", len(cmds.ls()), "| group exists:", cmds.objExists(group_name))',
      'print("group members:", len(cmds.listRelatives(group_name, children=True) or []))',
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
