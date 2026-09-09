/**
 * Headless Maya execution through `mayapy.exe`.
 *
 * `mayapy` is Maya's Python interpreter with `maya.standalone` available: it
 * runs a script in a real (GUI-less) Maya without needing a running Maya
 * instance, which makes it the right way to verify a script before handing it
 * to the user. This module spawns it, captures bounded stdout/stderr, and
 * reports the exit code.
 */
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MAX_STREAM_BYTES = 256 * 1024;

/** Standard install roots scanned when no mayapy path is configured. */
const MAYAPY_SEARCH_ROOTS = [
  'D:\\losheep\\tools\\Maya',
  'C:\\Program Files\\Autodesk',
];

/**
 * Find a usable `mayapy.exe`.
 * @param {string} [configured] explicit path from configuration.
 * @returns {Promise<string|null>} the first existing candidate.
 */
export async function detectMayapy(configured) {
  const candidates = [];
  if (configured) candidates.push(configured);
  if (process.env.DSH_MAYA_MAYAPY) candidates.push(process.env.DSH_MAYA_MAYAPY);
  for (const root of MAYAPY_SEARCH_ROOTS) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && /^Maya\d{4}$/.test(entry.name)) {
          candidates.push(join(root, entry.name, 'bin', 'mayapy.exe'));
        }
      }
    } catch {
      /* root absent: skip */
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Run a Python script (or inline code) with mayapy.
 * @param {object} options
 * @param {string} [options.scriptPath] existing .py file to run.
 * @param {string} [options.code] inline Python source, written to a temp file.
 * @param {string[]} [options.args] extra argv passed to the script.
 * @param {string} options.mayapy mayapy.exe path.
 * @param {string} [options.cwd] working directory.
 * @param {number} [options.timeoutMs] wall-clock budget.
 * @param {AbortSignal} [options.signal] cooperative cancellation.
 * @returns {Promise<{ok: boolean, exitCode: number|null, stdout: string, stderr: string, truncated: boolean, elapsedMs: number, scriptPath: string, mayapy: string}>}
 */
export async function runStandalone({ scriptPath, code, args = [], mayapy, cwd, timeoutMs = 300000, signal }) {
  if (!mayapy) throw new Error('mayapy.exe path is not configured; set the plugin config `mayapy` or the DSH_MAYA_MAYAPY environment variable');
  if (!scriptPath && code === undefined) throw new Error('maya_standalone needs either `script` (a .py path) or `code`');

  let target = scriptPath;
  if (!target) {
    const dir = join(tmpdir(), 'dsh-maya-standalone');
    await mkdir(dir, { recursive: true });
    target = join(dir, 'dsh_maya_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.py');
    await writeFile(target, withTrailer(code), 'utf8');
  }

  const started = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const child = spawn(mayapy, [target, ...args], {
      cwd: cwd ?? undefined,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };

    const collect = (stream) => (chunk) => {
      const text = chunk.toString('utf8');
      if (stream === 'out') {
        if (stdout.length >= MAX_STREAM_BYTES) { truncated = true; return; }
        stdout += text;
        if (stdout.length > MAX_STREAM_BYTES) { stdout = stdout.slice(0, MAX_STREAM_BYTES); truncated = true; }
      } else {
        if (stderr.length >= MAX_STREAM_BYTES) { truncated = true; return; }
        stderr += text;
        if (stderr.length > MAX_STREAM_BYTES) { stderr = stderr.slice(0, MAX_STREAM_BYTES); truncated = true; }
      }
    };

    const onAbort = () => {
      child.kill('SIGKILL');
      finish(reject, new Error('maya_standalone aborted by caller'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(resolve, {
        ok: false,
        exitCode: null,
        stdout: stdout + '\n[timeout after ' + timeoutMs + 'ms — mayapy killed]',
        stderr,
        truncated,
        elapsedMs: Date.now() - started,
        scriptPath: target,
        mayapy,
      });
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) { child.kill('SIGKILL'); return finish(reject, new Error('maya_standalone aborted before dispatch')); }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.on('error', (error) => finish(reject, new Error('failed to start mayapy (' + mayapy + '): ' + error.message)));
    child.on('close', (exitCode) => finish(resolve, {
      ok: exitCode === 0,
      exitCode,
      stdout,
      stderr,
      truncated,
      elapsedMs: Date.now() - started,
      scriptPath: target,
      mayapy,
    }));
  });
}

/** Append the interpreter's own version probe to a script for diagnostics. */
function withTrailer(code) {
  return code + '\n';
}

/** Probe mayapy for its Python version without initializing Maya. */
export async function probeMayapy(mayapy, timeoutMs = 20000) {
  if (!mayapy) return { available: false, detail: 'not configured' };
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(mayapy, ['-c', 'import sys; print(sys.version)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (value) => { if (done) return; done = true; resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ available: false, detail: 'timeout' }); }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); finish({ available: false, detail: error.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({
        available: code === 0,
        detail: (code === 0 ? out : err || out).trim().split('\n')[0] ?? '',
        elapsedMs: Date.now() - started,
      });
    });
  });
}
