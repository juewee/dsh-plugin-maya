#!/usr/bin/env node
/**
 * Integration test for dsh-plugin-maya.
 *
 * The plugin is mounted into a REAL Cordis context with the real DSH tool
 * registry, so every check goes through the production pipeline
 * (`ctx.tools.schemas()` projection, argument validation, `ctx.tools.execute`).
 *
 * Three groups of checks:
 *
 *  1. registry + documentation tools — always run;
 *  2. maya_cmd against a fake command port whose "Maya" is a real Python
 *     interpreter executing the payload this client sends (always runs);
 *  3. maya_standalone against a real mayapy.exe — runs only when the
 *     interpreter exists, otherwise skipped so the suite stays CI-runnable.
 *
 * Requires `@deepseek-ai/cordis`, `@deepseek-ai/dsh-system-prompt` and
 * `@deepseek-ai/dsh-tools`: install the devDependencies (`npm install`) or link
 * an existing DSH installation (`npm run link`).
 *
 * Environment:
 *   TEST_MAYAPY   path to mayapy.exe (default: the machine's Maya 2025 install)
 *   TEST_PYTHON   interpreter used as the fake Maya (default: mayapy, else python3)
 */
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAYAPY = process.env.TEST_MAYAPY ?? 'D:\\losheep\\tools\\Maya\\Maya2025\\bin\\mayapy.exe';
const MAYAPY_AVAILABLE = existsSync(MAYAPY);
const PYTHON = process.env.TEST_PYTHON ?? (MAYAPY_AVAILABLE ? MAYAPY : 'python3');

let failures = 0;
let skipped = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log('  PASS  ' + label + (detail ? ' — ' + detail : ''));
  } else {
    failures += 1;
    console.log('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}
function skip(label, reason) {
  skipped += 1;
  console.log('  SKIP  ' + label + ' — ' + reason);
}
function section(title) {
  console.log('\n=== ' + title + ' ===');
}

/** Dispatch one call through the real registry pipeline. */
let callIndex = 0;
async function callTool(ctx, name, args) {
  callIndex += 1;
  return ctx.tools.execute({
    callId: 'test-' + callIndex,
    name,
    arguments: args,
    signal: new AbortController().signal,
  });
}
function textOf(result) {
  return (result.content ?? []).map((block) => block.text ?? '').join('\n');
}

/** A fake Maya command port: decodes the payload this client sends and runs it with real Python. */
async function startFakeMaya() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-maya-fake-'));
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const statement = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const match = /b64decode\('([A-Za-z0-9+/=]+)'\)/.exec(statement);
      if (!match) {
        socket.end('unparsable statement\n');
        return;
      }
      const payload = Buffer.from(match[1], 'base64').toString('utf8');
      const file = join(dir, 'payload_' + Date.now() + '.py');
      await writeFile(file, payload, 'utf8');
      const child = spawn(PYTHON, [file], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (chunkData) => { out += chunkData.toString('utf8'); });
      child.stderr.on('data', (chunkData) => { out += chunkData.toString('utf8'); });
      child.on('error', (error) => { socket.end('fake maya failed to start ' + PYTHON + ': ' + error.message + '\n'); });
      child.on('close', () => { socket.write(out); });
    });
    socket.on('error', () => {});
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, port: server.address().port, dir };
}

async function main() {
  console.log('mayapy: ' + (MAYAPY_AVAILABLE ? MAYAPY : 'not found (standalone checks will be skipped)'));
  console.log('fake Maya python: ' + PYTHON);

  section('mount plugin into a real Cordis + dsh-tools context');
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools, { mode: 'native' });
  const plugin = await import('../lib/index.js');
  await ctx.plugin(plugin, {
    docsRoot: join(PLUGIN_ROOT, 'data'),
    defaultVersion: '2025',
    mayapy: MAYAPY_AVAILABLE ? MAYAPY : null,
    debugLogPath: join(PLUGIN_ROOT, 'test', 'load.log'),
  });
  const names = ctx.tools.schemas().map((schema) => schema.name).filter((name) => name.startsWith('maya_'));
  check('seven maya tools registered', names.length === 7, names.join(', '));

  section('maya_status');
  const status = await callTool(ctx, 'maya_status', { probe: true });
  const statusText = textOf(status);
  check('maya_status succeeds', !status.isError, statusText.split('\n')[0]);
  check('reports documentation versions', /Maya 2025 \(\d+ commands\)/.test(statusText));
  if (MAYAPY_AVAILABLE) check('reports a working mayapy', /mayapy: .*mayapy\.exe/.test(statusText), statusText.split('\n')[0]);
  else skip('reports a working mayapy', 'mayapy not installed');

  section('maya_doc_search');
  const search = await callTool(ctx, 'maya_doc_search', { query: 'polySphere', limit: 3 });
  const searchText = textOf(search);
  check('ranks the exact name first', /^- polySphere/m.test(searchText), searchText.split('\n')[1]);
  check('shows category and example marker', /\[Modeling \/ Polygon Meshes\] \(examples\)/.test(searchText));
  const topic = await callTool(ctx, 'maya_doc_search', { query: 'skinning', limit: 3 });
  check('topic search matches', /match\(es\) for "skinning"/.test(textOf(topic)), textOf(topic).split('\n')[0]);
  const filtered = await callTool(ctx, 'maya_doc_search', { query: 'create', category: 'Skinning', limit: 5 });
  check('category filter applies', /match\(es\)/.test(textOf(filtered)), textOf(filtered).split('\n')[0]);

  section('maya_doc_get');
  const got = await callTool(ctx, 'maya_doc_get', { names: ['addAttr', 'polySphere', 'no_such_command_xyz'] });
  const gotText = textOf(got);
  check('returns the description', gotText.includes('dynamic attribute'));
  check('returns verbatim examples', /cmds\.polySphere/.test(gotText));
  check('marks unknown names honestly', gotText.includes('not found in the Maya 2025 documentation index'));

  section('maya_doc_categories');
  const cats = await callTool(ctx, 'maya_doc_categories', {});
  check('returns the category tree', textOf(cats).includes('Animation'));

  section('argument validation');
  const invalid = await callTool(ctx, 'maya_doc_search', { limit: 5 });
  check('missing required query rejected', invalid.isError === true && /query is required/.test(textOf(invalid)), textOf(invalid));

  section('maya_cmd against a fake command port (real Python executes the payload)');
  const fake = await startFakeMaya();
  const okRun = await callTool(ctx, 'maya_cmd', { code: 'print("hello from maya")', port: fake.port, timeoutMs: 60000 });
  const okText = textOf(okRun);
  check('captures printed output', okText.includes('hello from maya'), okText.split('\n')[0]);
  check('reports success', okText.startsWith('maya_cmd ok'), okText.split('\n')[0]);

  const failRun = await callTool(ctx, 'maya_cmd', { code: 'raise ValueError("boom")', port: fake.port, timeoutMs: 60000 });
  const failText = textOf(failRun);
  check('reports failure', failText.startsWith('maya_cmd FAILED'), failText.split('\n')[0]);
  check('captures the traceback', failText.includes('ValueError: boom'));

  const stateRun = await callTool(ctx, 'maya_cmd', { code: 'x = 2 + 3\nprint("sum", x)', port: fake.port, timeoutMs: 60000 });
  check('multiline payload works', textOf(stateRun).includes('sum 5'));

  const unreachable = await callTool(ctx, 'maya_cmd', { code: 'print(1)', port: 1, timeoutMs: 3000 });
  check('unreachable port gives the setup hint', unreachable.isError === true && /commandPort/.test(textOf(unreachable)), textOf(unreachable).slice(0, 120));

  fake.server.close();
  await rm(fake.dir, { recursive: true, force: true });

  section('maya_standalone with real mayapy.exe');
  if (!MAYAPY_AVAILABLE) {
    skip('standalone run', 'mayapy not installed at ' + MAYAPY);
  } else {
    const standalone = await callTool(ctx, 'maya_standalone', {
      code: [
        'import maya.standalone',
        'maya.standalone.initialize(name="python")',
        'import maya.cmds as cmds',
        'cube = cmds.polyCube(name="DshTestCube")',
        'sphere = cmds.polySphere(name="DshTestSphere", radius=2)',
        'print("created:", cube, sphere)',
        'print("meshes:", len(cmds.ls(type="mesh")))',
        'print("exists:", cmds.objExists("DshTestCube"))',
        'maya.standalone.uninitialize()',
      ].join('\n'),
      timeoutMs: 300000,
    });
    const standaloneText = textOf(standalone);
    check('mayapy run succeeds', standaloneText.startsWith('maya_standalone ok'), standaloneText.split('\n')[0]);
    check('Maya initialized and created geometry', standaloneText.includes('DshTestCube') && standaloneText.includes('meshes: 2'));
    check('isolated prefs skip the user userSetup.py', !/Failed to execute/.test(standaloneText));
  }

  section('maya_session (persistent headless Maya)');
  if (!MAYAPY_AVAILABLE) {
    skip('persistent session', 'mayapy not installed at ' + MAYAPY);
  } else {
    const workDir = await mkdtemp(join(tmpdir(), 'dsh-maya-session-test-'));
    const sceneFile = join(workDir, 'session_scene.ma');
    const scenePathLine = 'scene_path = ' + JSON.stringify(sceneFile);

    const first = await callTool(ctx, 'maya_session', { action: 'run', code: 'counter = 41\nprint("session alive")', timeoutMs: 180000 });
    check('session auto-starts on run', textOf(first).startsWith('maya_session run ok'), textOf(first).split('\n')[0]);

    const second = await callTool(ctx, 'maya_session', { action: 'run', code: 'print("counter:", counter + 1)', timeoutMs: 60000 });
    check('namespace persists between calls', textOf(second).includes('counter: 42'));

    const build = await callTool(ctx, 'maya_session', {
      action: 'run',
      code: [
        'import maya.cmds as cmds',
        'cmds.file(new=True, force=True)',
        'rig = cmds.group(em=True, name="rig")',
        'body = cmds.polyCube(name="body")[0]',
        'head = cmds.polySphere(name="head")[0]',
        'cmds.parent(body, head, rig)',
        'cmds.setAttr(head + ".translateY", 3)',
        scenePathLine,
        'cmds.file(rename=scene_path)',
        'cmds.file(save=True, type="mayaAscii")',
        'print("saved:", cmds.file(query=True, sceneName=True))',
      ].join('\n'),
      timeoutMs: 60000,
    });
    check('builds and saves a scene', textOf(build).includes('saved:'), textOf(build).split('\n')[0]);

    const opened = await callTool(ctx, 'maya_session', {
      action: 'run',
      code: [
        'import maya.cmds as cmds',
        'cmds.file(new=True, force=True)',
        scenePathLine,
        'cmds.file(scene_path, open=True, force=True)',
        'def walk(node, depth=0):',
        '    print("  " * depth + "- " + node + " [" + cmds.nodeType(node) + "]")',
        '    for child in cmds.listRelatives(node, children=True, fullPath=False) or []:',
        '        walk(child, depth + 1)',
        'roots = [node for node in cmds.ls(assemblies=True) if node == "rig"]',
        'print("roots:", roots)',
        'for root in roots:',
        '    walk(root)',
        'print("head.translateY:", cmds.getAttr("head.translateY"))',
      ].join('\n'),
      timeoutMs: 60000,
    });
    const openedText = textOf(opened);
    check('opens a saved .ma file', openedText.startsWith('maya_session run ok') && openedText.includes("roots: ['rig']"), openedText.split('\n')[0]);
    check('walks the DAG (Outliner) hierarchy', /- rig \[transform\]/.test(openedText) && /- body \[transform\]/.test(openedText) && /\[mesh\]/.test(openedText));
    check('reads attribute values from the opened file', openedText.includes('head.translateY: 3.0'));

    const status = await callTool(ctx, 'maya_status', { probe: false });
    check('maya_status reports the running session', /maya session: running \(pid \d+/.test(textOf(status)), textOf(status).split('\n').slice(-1)[0]);

    const stopped = await callTool(ctx, 'maya_session', { action: 'stop' });
    check('session stops cleanly', textOf(stopped).includes('stopped'), textOf(stopped).split('\n')[0]);
    const afterStop = await callTool(ctx, 'maya_status', { probe: false });
    check('status shows the session is gone', /maya session: not running/.test(textOf(afterStop)));

    await rm(workDir, { recursive: true, force: true });
  }

  await ctx.fiber.dispose();
  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') + (skipped ? ' (' + skipped + ' skipped)' : ''));
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('test harness crashed: ' + (error?.stack ?? error));
  process.exitCode = 1;
});
