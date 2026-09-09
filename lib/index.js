/**
 * dsh-plugin-maya — Maya scripting assistant for DeepSeek Harness.
 *
 * Registers seven tools on `ctx.tools`:
 *   maya_status          what Maya toolchain this session can use
 *   maya_doc_search      offline maya.cmds documentation search
 *   maya_doc_get         full documentation entry (description + examples)
 *   maya_doc_categories  category tree for browsing by topic
 *   maya_cmd             run Python inside a running Maya GUI (command port)
 *   maya_standalone      run a script headlessly with mayapy.exe
 *   maya_session         persistent headless Maya, state kept across calls
 *
 * The plugin is dependency-free on purpose: it can be mounted straight from a
 * `file://` URL in a profile patch layer, with no pnpm install step.
 */
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { defineTool, text } from './schema.js';
import { MayaDocStore } from './maya-docs.js';
import { MayaPortUnavailableError, probePort, runInMaya } from './command-port.js';
import { detectMayapy, ensurePrefsDir, probeMayapy, runStandalone } from './standalone.js';
import { MayaSession } from './session.js';

/** Loader-visible plugin name. */
export const name = 'dsh-plugin-maya';
/** The tool registry is the only hard dependency. */
export const inject = ['tools'];

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Resolve the effective configuration. */
function resolveConfig(config = {}) {
  return {
    docsRoot: config.docsRoot ?? join(PLUGIN_ROOT, 'data'),
    defaultVersion: String(config.defaultVersion ?? '2025'),
    mayapy: config.mayapy ?? null,
    commandPortHost: config.commandPortHost ?? '127.0.0.1',
    commandPortPort: Number(config.commandPortPort ?? 6000),
    melWrapper: config.melWrapper === true,
    maxExampleChars: Number(config.maxExampleChars ?? 2500),
    debugLogPath: config.debugLogPath ?? null,
  };
}

/** Append one diagnostic line to the optional load/usage log. */
async function log(config, event, detail) {
  if (!config.debugLogPath) return;
  try {
    await appendFile(config.debugLogPath, JSON.stringify({ time: new Date().toISOString(), plugin: name, event, ...detail }) + '\n', 'utf8');
  } catch {
    /* diagnostics must never break the plugin */
  }
}

/** One-line category label for a command. */
function categoryLabel(categories) {
  return categories.length > 0 ? categories.join(' | ') : '(uncategorized)';
}

/** Render a bounded text block for tool output. */
function block(title, body) {
  return body && body.length > 0 ? title + '\n' + body : title;
}

/** One-line description of a headless session's scene. */
function sceneLine(scene) {
  if (!scene) return 'scene: (unavailable)';
  return 'scene: ' + (scene.file ?? '<empty/unsaved>')
    + ' | nodes: ' + scene.nodes
    + (scene.modified ? ' | modified' : '')
    + (scene.selection?.length ? ' | selection: ' + scene.selection.join(', ') : '');
}
/**
 * Register every Maya tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx registrant context.
 * @param {object} [config] plugin configuration.
 */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config);
  const docs = new MayaDocStore(settings.docsRoot);
  const session = new MayaSession();

  ctx.tools.register(defineTool({
    name: 'maya_status',
    description: 'Report the Maya toolchain available to this session: the mayapy.exe path and Python version, whether a Maya command port is reachable, and which offline Maya documentation versions are installed. Call this once at the start of a Maya task so you know what can actually be executed and which doc version applies.',
    parameters: {
      type: 'object',
      properties: {
        probe: { type: 'boolean', description: 'When true (default), also probe mayapy and the command port; false only reports configured paths.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value.report),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const probe = args.probe !== false;
      const mayapy = await detectMayapy(settings.mayapy);
      const mayapyProbe = probe && mayapy ? await probeMayapy(mayapy) : null;
      const port = probe
        ? await probePort({ host: settings.commandPortHost, port: settings.commandPortPort })
        : { reachable: false, detail: 'not probed' };
      let versions = [];
      let docsError = null;
      try {
        versions = await docs.summaries();
      } catch (error) {
        docsError = error.message;
      }
      const lines = [
        'mayapy: ' + (mayapy ?? 'not found (set config.mayapy or DSH_MAYA_MAYAPY)')
          + (mayapyProbe ? ' — ' + (mayapyProbe.available ? mayapyProbe.detail : 'unusable: ' + mayapyProbe.detail) : ''),
        'command port: ' + settings.commandPortHost + ':' + settings.commandPortPort + ' — ' + (port.reachable ? 'reachable' : 'not reachable (' + port.detail + ')'),
        'docs root: ' + settings.docsRoot,
        'maya session: ' + (session.running
          ? 'running (pid ' + session.status().pid + ', up ' + Math.round(session.status().uptimeMs / 1000) + 's)'
          : 'not running (start it with maya_session action "start")'),
      ];
      if (docsError) lines.push('docs: unavailable — ' + docsError);
      else if (versions.length === 0) lines.push('docs: no version directories found');
      else lines.push('docs: ' + versions.map((v) => 'Maya ' + v.version + ' (' + v.commands + ' commands)').join(', ') + ' | default ' + settings.defaultVersion);
      await log(settings, 'maya_status', { mayapy, reachable: port.reachable });
      return {
        report: lines.join('\n'),
        mayapy: mayapy ?? null,
        mayapyAvailable: Boolean(mayapyProbe?.available),
        commandPort: { host: settings.commandPortHost, port: settings.commandPortPort, reachable: port.reachable },
        session: session.status(),
        docsRoot: settings.docsRoot,
        versions: versions.map((v) => ({ version: v.version, commands: v.commands })),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'maya_doc_search',
    description: 'Search the offline Maya Python command documentation (maya.cmds, scraped from the Autodesk Maya 2020/2022/2025 Chinese Tech-Docs). Use it before writing Maya code to confirm a command exists and to learn its exact name and category; then call maya_doc_get for syntax and examples. Matching order: exact name, name prefix, name substring, then description/topic keywords.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', required: true, description: 'Command name fragment or topic keyword, e.g. "polySphere", "blendshape", "uv", "render layer".' },
        version: { type: 'string', enum: ['2020', '2022', '2025'], description: 'Maya documentation version; defaults to the plugin default (usually 2025).' },
        category: { type: 'string', description: 'Optional category/subcategory substring filter, e.g. "Skinning" or "Rendering".' },
        limit: { type: 'integer', description: 'Maximum rows returned (default 15, max 50).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value.report),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const limit = Math.min(Math.max(Number(args.limit ?? 15), 1), 50);
      const result = await docs.search({
        query: args.query,
        version: args.version,
        fallbackVersion: settings.defaultVersion,
        category: args.category,
        limit,
      });
      const lines = ['Maya ' + result.version + ' docs — ' + result.matched + ' match(es) for "' + args.query + '" of ' + result.total + ' commands (showing ' + result.results.length + ')'];
      if (result.results.length === 0) lines.push('(no match — try a shorter fragment, a category filter, or maya_doc_categories to browse)');
      for (const row of result.results) {
        lines.push('- ' + row.name + '  [' + categoryLabel(row.categories) + ']'
          + (row.isMelScript ? ' (MEL script)' : '')
          + (row.hasExamples ? ' (examples)' : '')
          + (row.error ? ' (' + row.error + ')' : ''));
        if (row.summary) lines.push('    ' + row.summary);
      }
      await log(settings, 'maya_doc_search', { query: args.query, version: result.version, matched: result.matched });
      return { report: lines.join('\n'), ...result };
    },
  }));
  ctx.tools.register(defineTool({
    name: 'maya_doc_get',
    description: 'Return the full offline documentation entry for one or more Maya commands: description, verbatim Python examples from the official docs, category, and the Autodesk URL. Use it after maya_doc_search, or directly when you already know the command name. Long examples are truncated.',
    parameters: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          required: true,
          minItems: 1,
          maxItems: 8,
          items: { type: 'string' },
          description: 'Command names without the cmds. prefix, e.g. ["addAttr", "polySphere"].',
        },
        version: { type: 'string', enum: ['2020', '2022', '2025'], description: 'Maya documentation version; defaults to the plugin default.' },
        maxExampleChars: { type: 'integer', description: 'Per-command example truncation limit (default from config, 2500).' },
      },
      required: ['names'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value.report),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const maxExampleChars = Math.min(Math.max(Number(args.maxExampleChars ?? settings.maxExampleChars), 200), 20000);
      const result = await docs.getCommands({
        names: args.names.map((item) => String(item).replace(/^cmds\./, '').trim()),
        version: args.version,
        fallbackVersion: settings.defaultVersion,
        maxExampleChars,
      });
      const chunks = [];
      for (const command of result.commands) {
        const head = '### ' + command.name + '  (Maya ' + result.version + ')';
        if (!command.known) {
          chunks.push(head + '\nnot found in the Maya ' + result.version + ' documentation index.');
          continue;
        }
        const lines = [head, 'category: ' + categoryLabel(command.categories) + (command.isMelScript ? ' | MEL script' : '')];
        if (command.error) lines.push('note: ' + command.error + ' (no Python-specific page)');
        if (command.description) lines.push('description: ' + command.description.replace(/\s+/g, ' ').trim());
        if (command.examples) lines.push('examples:\n' + command.examples.trim());
        if (command.url) lines.push('url: ' + command.url);
        chunks.push(lines.join('\n'));
      }
      await log(settings, 'maya_doc_get', { names: args.names, version: result.version });
      return { report: chunks.join('\n\n'), ...result };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'maya_doc_categories',
    description: 'List the Maya command category tree (category > subcategory with command counts) for one documentation version. Use it to browse the docs by topic when you do not know a command name, then feed a subcategory into maya_doc_search via its category filter.',
    parameters: {
      type: 'object',
      properties: {
        version: { type: 'string', enum: ['2020', '2022', '2025'], description: 'Maya documentation version; defaults to the plugin default.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value.report),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const result = await docs.categoryTree({ version: args.version, fallbackVersion: settings.defaultVersion });
      const lines = ['Maya ' + result.version + ' command categories'];
      for (const category of result.categories) {
        lines.push('- ' + category.category + ' (' + category.commandCount + ')');
        for (const sub of category.subcategories) lines.push('    ' + sub.subcategory + ' (' + sub.commandCount + ')');
      }
      return { report: lines.join('\n'), ...result };
    },
  }));
  ctx.tools.register(defineTool({
    name: 'maya_cmd',
    description: 'Execute Python code inside a RUNNING Maya GUI through its command port and return the captured output. Requires Maya to have a command port open (cmds.commandPort(name=":6000", sourceType="python")). Use it to inspect or modify the live scene, to check that objects exist, and to verify a script in the user\'s actual session. Code runs on Maya\'s main thread; print() output and tracebacks are captured, and a raised exception returns ok=false with the traceback.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', required: true, description: 'Python source executed inside Maya. maya.cmds is NOT pre-imported — start with "import maya.cmds as cmds".' },
        host: { type: 'string', description: 'Command port host (default 127.0.0.1).' },
        port: { type: 'integer', description: 'Command port number (default 6000).' },
        timeoutMs: { type: 'integer', description: 'Wall-clock budget in milliseconds (default 20000).' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value.report),
    },
    async execute(args, exec) {
      const host = args.host ?? settings.commandPortHost;
      const port = Number(args.port ?? settings.commandPortPort);
      try {
        const result = await runInMaya({
          code: args.code,
          host,
          port,
          timeoutMs: Math.min(Math.max(Number(args.timeoutMs ?? 20000), 500), 600000),
          melWrapper: settings.melWrapper,
          signal: exec?.signal,
        });
        await log(settings, 'maya_cmd', { host, port, ok: result.ok, elapsedMs: result.elapsedMs });
        const header = (result.ok ? 'maya_cmd ok' : 'maya_cmd FAILED') + ' — ' + host + ':' + port + ' in ' + result.elapsedMs + 'ms'
          + (result.truncated ? ' (output truncated)' : '');
        return { report: block(header, result.output), ...result };
      } catch (error) {
        if (error instanceof MayaPortUnavailableError) {
          await log(settings, 'maya_cmd', { host, port, ok: false, error: error.code ?? 'unreachable' });
        }
        throw error;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'maya_standalone',
    description: 'Run a Maya Python script headlessly with mayapy.exe (maya.standalone, no GUI) and return stdout, stderr, and the exit code. Use it to test a script end to end in a fresh scene — creating geometry, saving/opening files, checking results with prints — before handing it to the user. Standalone mode has no GUI, no default cameras, and GUI-only commands (promptDialog, fileDialog, playblast windows) do not work.',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Absolute path to an existing .py file to run. Provide either script or code.' },
        code: { type: 'string', description: 'Inline Python source, written to a temp file and run. Provide either script or code.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra argv passed to the script.' },
        mayapy: { type: 'string', description: 'Override the mayapy.exe path for this call.' },
        cwd: { type: 'string', description: 'Working directory for the child process.' },
        cleanPrefs: { type: 'boolean', description: 'Isolate Maya preferences by pointing MAYA_APP_DIR at an empty directory (default true): skips the user\'s userSetup.py, starts ~2x faster and is reproducible. Set false when the script needs the user\'s plugins or shelf configuration.' },
        timeoutMs: { type: 'integer', description: 'Wall-clock budget in milliseconds (default 300000).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value.report),
    },
    async execute(args, exec) {
      const mayapy = args.mayapy ?? (await detectMayapy(settings.mayapy));
      if (!mayapy) throw new Error('mayapy.exe not found — set the plugin config mayapy (e.g. D:/losheep/tools/Maya/Maya2025/bin/mayapy.exe) or the DSH_MAYA_MAYAPY environment variable');
      const result = await runStandalone({
        scriptPath: args.script,
        code: args.code,
        args: args.args ?? [],
        mayapy,
        cwd: args.cwd,
        cleanPrefs: args.cleanPrefs !== false,
        timeoutMs: Math.min(Math.max(Number(args.timeoutMs ?? 300000), 1000), 3600000),
        signal: exec?.signal,
      });
      await log(settings, 'maya_standalone', { ok: result.ok, exitCode: result.exitCode, elapsedMs: result.elapsedMs, cleanPrefs: result.cleanPrefs });
      const header = 'maya_standalone ' + (result.ok ? 'ok' : 'FAILED') + ' — exit ' + result.exitCode + ' in ' + result.elapsedMs + 'ms'
        + '\nmayapy: ' + result.mayapy + '\nscript: ' + result.scriptPath
        + '\nprefs: ' + (result.cleanPrefs ? 'isolated (userSetup.py skipped)' : 'user preferences loaded');
      const parts = [header];
      if (result.stdout) parts.push('--- stdout ---\n' + result.stdout.trimEnd());
      if (result.stderr) parts.push('--- stderr ---\n' + result.stderr.trimEnd());
      if (!result.stdout && !result.stderr) parts.push('(no output)');
      return { report: parts.join('\n'), ...result };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'maya_session',
    description: 'Drive ONE persistent headless Maya (mayapy.exe) across multiple calls: action "start" boots it, action "run" executes Python in it, "status" reports it, "stop" shuts it down. Unlike maya_standalone (a fresh interpreter per call, about 5s of Maya startup each time), the session keeps its interpreter, its namespace and its loaded scene alive, so you can build a scene, open a .ma/.mb file, walk the DAG (Outliner), inspect attributes, tweak and save back over many calls. It is a private Maya instance and cannot see the running GUI scene; use maya_cmd for that. No command port or socket is involved. A call that exceeds timeoutMs kills the session; start it again to continue.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'start', 'status', 'stop'], description: 'run (default) executes code; start boots the session if needed; status reports pid/uptime/scene; stop shuts it down.' },
        code: { type: 'string', description: 'Python source for action "run". Variables, imports and the open scene persist between calls. maya.cmds is already imported as cmds.' },
        mayapy: { type: 'string', description: 'Override the mayapy.exe path (action start).' },
        cleanPrefs: { type: 'boolean', description: 'Isolate Maya preferences via MAYA_APP_DIR (action start, default true): skips userSetup.py, starts faster, reproducible. Set false to load the user plugins and preferences.' },
        timeoutMs: { type: 'integer', description: 'Per-call budget in milliseconds: 60000 for run, 180000 for start.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value.report),
    },
    async execute(args, exec) {
      const action = args.action ?? 'run';
      const cleanPrefs = args.cleanPrefs !== false;

      const startSession = async (timeoutMs) => {
        const mayapy = args.mayapy ?? (await detectMayapy(settings.mayapy));
        if (!mayapy) throw new Error('mayapy.exe not found - set the plugin config mayapy (e.g. D:/losheep/tools/Maya/Maya2025/bin/mayapy.exe) or the DSH_MAYA_MAYAPY environment variable');
        return session.start({
          mayapy,
          cleanPrefs,
          prefsDir: cleanPrefs ? await ensurePrefsDir() : null,
          timeoutMs: Math.min(Math.max(Number(timeoutMs ?? 180000), 5000), 900000),
        });
      };

      if (action === 'start') {
        const status = await startSession(args.timeoutMs);
        await log(settings, 'maya_session', { action, pid: status.pid, startupMs: status.startupMs });
        const report = [
          'maya_session started - pid ' + status.pid + ' in ' + status.startupMs + 'ms',
          'mayapy: ' + status.mayapy,
          'python: ' + status.python + ' | prefs: ' + (status.cleanPrefs ? 'isolated' : 'user preferences'),
          sceneLine(status.scene),
        ].join('\n');
        return { report, session: status, scene: status.scene };
      }

      if (action === 'status') {
        const status = session.status();
        const lines = [
          'maya_session status - ' + (status.running ? 'running (pid ' + status.pid + ', up ' + Math.round(status.uptimeMs / 1000) + 's)' : 'not running'),
          'mayapy: ' + (status.mayapy ?? '(none started yet)'),
          'prefs: ' + (status.cleanPrefs ? 'isolated' : 'user preferences'),
        ];
        if (status.running) lines.push(sceneLine(status.scene));
        if (status.stderrTail) lines.push('stderr tail: ' + status.stderrTail.replace(/\s+/g, ' ').slice(0, 300));
        return { report: lines.join('\n'), session: status };
      }

      if (action === 'stop') {
        const closed = await session.stop();
        await log(settings, 'maya_session', { action, ...closed });
        return { report: 'maya_session stopped - ' + closed.detail, session: session.status() };
      }

      if (typeof args.code !== 'string' || args.code.trim() === '') {
        throw new Error('maya_session action "run" requires code');
      }
      let autoStarted = false;
      if (!session.running) {
        await startSession(args.timeoutMs);
        autoStarted = true;
      }
      const result = await session.run(args.code, {
        timeoutMs: Math.min(Math.max(Number(args.timeoutMs ?? 60000), 500), 900000),
        signal: exec?.signal,
      });
      await log(settings, 'maya_session', { action: 'run', ok: result.ok, elapsedMs: result.elapsedMs });
      const parts = ['maya_session run ' + (result.ok ? 'ok' : 'FAILED') + ' - ' + result.elapsedMs + 'ms'
        + (autoStarted ? ' (session started automatically)' : '')];
      if (result.stdout) parts.push(result.stdout.trimEnd());
      if (result.stderr) parts.push('--- stderr ---\n' + result.stderr.trimEnd());
      if (result.error) parts.push('--- traceback ---\n' + result.error.trimEnd());
      if (result.stray) parts.push('--- raw fd-1 output ---\n' + result.stray.trimEnd());
      if (!result.stdout && !result.stderr && !result.error) parts.push('(no output)');
      parts.push(sceneLine(result.scene));
      return { report: parts.join('\n'), ...result, session: session.status() };
    },
  }));

  ctx.on('dispose', () => {
    void session.stop();
    void log(settings, 'unloaded', {});
  });
  void log(settings, 'loaded', { docsRoot: settings.docsRoot, defaultVersion: settings.defaultVersion, mayapy: settings.mayapy });
}
