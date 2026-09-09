/**
 * Persistent headless Maya session.
 *
 * One `mayapy.exe` process is started once and kept alive; Python source is sent
 * over stdin and results come back sentinel-framed over stdout (see
 * session-driver.py). Because the interpreter and the loaded scene stay alive,
 * variables, imports and opened files persist between calls — a fresh
 * `maya_standalone` run costs ~5s of Maya startup every time, a session pays it
 * once.
 *
 * No socket, no command port, no authentication: this is an ordinary child
 * process of the DSH host, isolated from the user's running Maya.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DRIVER = join(dirname(fileURLToPath(import.meta.url)), 'session-driver.py');
const MAX_BUFFER_BYTES = 256 * 1024;

export class MayaSession {
  #child = null;
  #token = '';
  #buffer = '';
  #stray = '';
  #pending = null;
  #readyWaiter = null;
  #queue = Promise.resolve();
  #stderrTail = '';

  /** @type {string|null} */
  mayapy = null;
  startedAt = 0;
  cleanPrefs = true;
  lastScene = null;
  lastReady = null;

  get running() {
    return Boolean(this.#child && this.#child.exitCode === null && !this.#child.killed);
  }

  /** Cheap, non-invasive status snapshot. */
  status() {
    return {
      running: this.running,
      mayapy: this.mayapy,
      pid: this.#child?.pid ?? null,
      uptimeMs: this.running ? Date.now() - this.startedAt : 0,
      cleanPrefs: this.cleanPrefs,
      scene: this.lastScene,
      startupMs: this.lastReady?.elapsedMs ?? null,
      python: this.lastReady?.python ?? null,
      stderrTail: this.#stderrTail.trim().slice(-2000) || null,
    };
  }

  /**
   * Start the session if it is not already running.
   * @param {{mayapy: string, cleanPrefs?: boolean, prefsDir?: string, timeoutMs?: number}} options
   */
  async start({ mayapy, cleanPrefs = true, prefsDir, timeoutMs = 180000 } = {}) {
    if (this.running) return this.status();
    if (!mayapy) throw new Error('mayapy.exe path is not configured; set the plugin config `mayapy` or the DSH_MAYA_MAYAPY environment variable');

    this.#token = randomBytes(8).toString('hex');
    this.#buffer = '';
    this.#stray = '';
    this.#stderrTail = '';
    this.mayapy = mayapy;
    this.cleanPrefs = cleanPrefs;
    this.startedAt = Date.now();
    this.lastScene = null;
    this.lastReady = null;

    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    if (cleanPrefs && prefsDir) env.MAYA_APP_DIR = prefsDir;

    const child = spawn(mayapy, [DRIVER, this.#token], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr.on('data', (chunk) => { this.#stderrTail = (this.#stderrTail + chunk).slice(-8000); });
    child.on('error', (error) => this.#onExit(child, null, 'failed to start mayapy (' + mayapy + '): ' + error.message));
    child.on('close', (code) => this.#onExit(child, code, null));

    const ready = new Promise((resolve, reject) => { this.#readyWaiter = { resolve, reject }; });
    const timer = setTimeout(() => {
      this.#readyWaiter = null;
      this.#kill();
      reject(new Error('Maya session did not become ready within ' + timeoutMs + 'ms'));
    }, timeoutMs);

    try {
      const info = await ready;
      this.lastReady = info;
      this.lastScene = info.scene ?? null;
      return this.status();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Execute Python in the live session namespace. Calls are serialized.
   * @param {string} code
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   */
  run(code, options = {}) {
    const task = this.#queue.then(() => this.#execute(code, options.timeoutMs ?? 60000, options.signal));
    this.#queue = task.then(() => undefined, () => undefined);
    return task;
  }

  /** Ask the session to exit, then make sure it is gone. */
  async stop({ timeoutMs = 10000 } = {}) {
    const child = this.#child;
    if (!child) return { closed: true, detail: 'no session was running' };
    try {
      child.stdin.write(JSON.stringify({ action: 'shutdown', id: 'shutdown' }) + '\n');
    } catch {
      /* already gone */
    }
    await new Promise((resolveClose) => {
      const timer = setTimeout(() => { this.#kill(); resolveClose(); }, timeoutMs);
      child.once('close', () => { clearTimeout(timer); resolveClose(); });
    });
    return { closed: true, detail: 'session closed' };
  }

  #execute(code, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      if (!this.running) {
        reject(new Error('no Maya session is running — call maya_session with action "start" first'));
        return;
      }
      const id = randomBytes(4).toString('hex');
      const timer = setTimeout(() => {
        this.#pending = null;
        this.#kill();
        reject(new Error('maya_session call exceeded ' + timeoutMs + 'ms — the session was killed and must be restarted; the code may still have been running inside Maya'));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.#pending = null;
        this.#kill();
        reject(new Error('maya_session aborted by caller — the session was killed and must be restarted'));
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#pending = {
        resolve: (message) => {
          signal?.removeEventListener?.('abort', onAbort);
          if (message.scene) this.lastScene = message.scene;
          resolve({ ...message, stray: this.#stray });
          this.#stray = '';
        },
        reject,
        timer,
      };
      try {
        this.#child.stdin.write(JSON.stringify({ id, code }) + '\n');
      } catch (error) {
        this.#pending = null;
        clearTimeout(timer);
        reject(new Error('failed to send code to the Maya session: ' + error.message));
      }
    });
  }

  #onStdout(chunk) {
    this.#buffer += chunk;
    const marker = '__DSH_SESSION_' + this.#token + '__';
    for (;;) {
      const start = this.#buffer.indexOf(marker);
      if (start === -1) break;
      const end = this.#buffer.indexOf('__END__', start);
      if (end === -1) break;
      const before = this.#buffer.slice(0, start);
      const payload = this.#buffer.slice(start + marker.length, end);
      this.#buffer = this.#buffer.slice(end + '__END__'.length);
      if (before.trim()) this.#stray = (this.#stray + before).slice(-MAX_BUFFER_BYTES);
      let message;
      try {
        message = JSON.parse(payload);
      } catch {
        continue;
      }
      this.#dispatch(message);
    }
    if (this.#buffer.length > MAX_BUFFER_BYTES) this.#buffer = this.#buffer.slice(-MAX_BUFFER_BYTES);
  }

  #dispatch(message) {
    if (message.event === 'ready') {
      this.lastReady = message;
      this.#readyWaiter?.resolve(message);
      this.#readyWaiter = null;
      return;
    }
    if (message.event === 'fatal') {
      this.#readyWaiter?.reject(new Error('Maya session driver failed: ' + message.error));
      this.#readyWaiter = null;
      return;
    }
    const pending = this.#pending;
    this.#pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  #onExit(child, code, errorText) {
    if (this.#child === child) this.#child = null;
    const tail = this.#stderrTail.trim();
    const suffix = tail ? '\nstderr tail:\n' + tail.slice(-1000) : '';
    const message = errorText ?? ('Maya session exited (code ' + code + ')');
    this.#readyWaiter?.reject(new Error(message + suffix));
    this.#readyWaiter = null;
    const pending = this.#pending;
    this.#pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message + suffix));
    }
  }

  #kill() {
    const child = this.#child;
    this.#child = null;
    try {
      child?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
