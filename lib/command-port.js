/**
 * Maya command-port client.
 *
 * Maya's command port (opened in Maya with
 * `cmds.commandPort(name=":6000", sourceType="python")`) executes whatever
 * Python text is sent over the socket and echoes the Script Editor output back
 * on the same connection. There is no request/response framing, so this client
 * adds its own: the payload is base64-wrapped into ONE Python statement, and the
 * wrapper prints a random sentinel line when the payload finished, which is what
 * the reader waits for. That makes result capture deterministic instead of the
 * usual "recv() once and hope".
 */
import { randomBytes } from 'node:crypto';
import net from 'node:net';

/** Error thrown when Maya's command port is not reachable. */
export class MayaPortUnavailableError extends Error {
  constructor(host, port, cause) {
    super(
      'Maya command port ' + host + ':' + port + ' is not reachable (' + (cause?.code ?? cause?.message ?? 'unknown') + '). '
      + 'Open it inside Maya with: import maya.cmds as cmds; cmds.commandPort(name=":' + port + '", sourceType="python") '
      + '— or persist it in userSetup.py under <documents>/maya/<version>/scripts/.',
    );
    this.name = 'MayaPortUnavailableError';
    this.code = cause?.code;
  }
}

/** Build the single-line Python statement Maya will execute. */
function buildStatement(payload, melWrapper) {
  const encoded = Buffer.from(payload, 'utf8').toString('base64');
  const inner = "exec(compile(__import__('base64').b64decode('" + encoded + "').decode('utf-8'),'<dsh-maya>','exec'))";
  return melWrapper ? 'python("' + inner + '")' : inner;
}

/** Build the wrapper program: run the user code, then always print the sentinel. */
function buildPayload(code, sentinel) {
  const literal = JSON.stringify(code);
  return [
    'import traceback as _dsh_tb',
    '_dsh_src = ' + literal,
    '_dsh_ok = 1',
    'try:',
    '    exec(compile(_dsh_src, "<dsh-maya>", "exec"), {"__name__": "__dsh_maya__"})',
    'except BaseException:',
    '    _dsh_ok = 0',
    '    print(_dsh_tb.format_exc())',
    'print("' + sentinel + '" + str(_dsh_ok))',
  ].join('\n');
}

/**
 * Execute Python inside a running Maya GUI and capture its printed output.
 * @param {object} options
 * @param {string} options.code Python source to execute inside Maya.
 * @param {string} [options.host] command port host.
 * @param {number} [options.port] command port port.
 * @param {number} [options.timeoutMs] overall budget.
 * @param {boolean} [options.melWrapper] wrap in MEL `python("...")` for ports opened with sourceType="mel".
 * @param {AbortSignal} [options.signal] cooperative cancellation.
 * @returns {Promise<{ok: boolean, output: string, truncated: boolean, elapsedMs: number, host: string, port: number}>}
 */
export function runInMaya({ code, host = '127.0.0.1', port = 6000, timeoutMs = 20000, melWrapper = false, signal }) {
  const sentinel = '__DSH_MAYA_DONE_' + randomBytes(6).toString('hex') + '__';
  const statement = buildStatement(buildPayload(code, sentinel), melWrapper);
  const started = Date.now();
  const maxBytes = 512 * 1024;

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let truncated = false;
    let truncatedNoted = false;
    const socket = new net.Socket();

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener?.('abort', onAbort);
      socket.destroy();
      fn(value);
    };

    const onAbort = () => finish(reject, new Error('maya_cmd aborted by caller'));
    const deadline = setTimeout(() => {
      finish(resolve, {
        ok: false,
        output: clean(buffer, statement) + (buffer ? '\n' : '') + '[timeout after ' + timeoutMs + 'ms — Maya may still be executing]',
        truncated,
        elapsedMs: Date.now() - started,
        host,
        port,
      });
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) return finish(reject, new Error('maya_cmd aborted before dispatch'));
      signal.addEventListener('abort', onAbort, { once: true });
    }

    socket.setTimeout(timeoutMs);
    socket.on('error', (error) => finish(reject, new MayaPortUnavailableError(host, port, error)));
    socket.on('timeout', () => finish(reject, new MayaPortUnavailableError(host, port, { code: 'ETIMEDOUT' })));
    socket.on('close', () => {
      if (buffer.includes(sentinel)) return;
      finish(resolve, {
        ok: false,
        output: clean(buffer, statement) + (buffer ? '\n' : '') + '[connection closed before Maya reported completion]',
        truncated,
        elapsedMs: Date.now() - started,
        host,
        port,
      });
    });
    socket.on('data', (chunk) => {
      if (buffer.length < maxBytes) {
        buffer += chunk.toString('utf8');
        if (buffer.length > maxBytes) {
          truncated = true;
          buffer = buffer.slice(0, maxBytes);
          if (!truncatedNoted) {
            truncatedNoted = true;
            buffer += '\n[... output truncated at ' + maxBytes + ' bytes ...]\n';
          }
        }
      } else {
        truncated = true;
      }
      const index = buffer.indexOf(sentinel);
      if (index === -1) return;
      const ok = buffer.slice(index + sentinel.length, index + sentinel.length + 1) === '1';
      finish(resolve, {
        ok,
        output: clean(buffer.slice(0, index), statement),
        truncated,
        elapsedMs: Date.now() - started,
        host,
        port,
      });
    });

    socket.connect(port, host, () => {
      socket.write(statement + '\n');
    });
  });
}

/** Drop the echoed command line and normalize line endings. */
function clean(text, statement) {
  let out = text.replace(/\r\n/g, '\n');
  const head = statement.slice(0, 60);
  if (out.startsWith(head)) {
    const newline = out.indexOf('\n');
    out = newline === -1 ? '' : out.slice(newline + 1);
  }
  return out.replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * Probe a command port without running user code.
 * @param {object} options
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{reachable: boolean, detail: string}>}
 */
export function probePort({ host = '127.0.0.1', port = 6000, timeoutMs = 1500 }) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (reachable, detail) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ reachable, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.on('error', (error) => finish(false, error.code ?? error.message));
    socket.on('timeout', () => finish(false, 'ETIMEDOUT'));
    socket.on('close', () => finish(false, 'closed'));
    socket.connect(port, host, () => finish(true, 'listening'));
  });
}
