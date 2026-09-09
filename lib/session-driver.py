"""Persistent headless Maya session driver for dsh-plugin-maya.

Started once by lib/session.js as `mayapy.exe session-driver.py <token>`. It reads
one JSON request per line from stdin, executes the request's Python source in a
persistent namespace, and answers with one sentinel-framed JSON line on stdout:

    __DSH_SESSION_<token>__{"ok": true, "stdout": "...", ...}__END__

The sentinel lets the client separate protocol messages from anything the user's
code writes straight to file descriptor 1, so the protocol survives a stray
`os.write(1, ...)` or a C extension printing to the real stdout.

Protocol:
    {"action": "run", "id": "...", "code": "..."}   execute code, reply with a result
    {"action": "shutdown", "id": "..."}             reply, then exit

Because the namespace is reused, variables, imports and the loaded scene persist
between requests: this is a Maya session, not a fresh interpreter per call.
"""

import io
import json
import os
import sys
import time
import traceback

TOKEN = sys.argv[1] if len(sys.argv) > 1 else "local"
_real_stdout = sys.stdout
_real_stderr = sys.stderr


def _emit(payload):
    _real_stdout.write("__DSH_SESSION_%s__%s__END__\n" % (TOKEN, json.dumps(payload)))
    _real_stdout.flush()


def _scene_state():
    """Cheap snapshot of the session scene, for status lines and reports."""
    try:
        import maya.cmds as cmds
        selection = cmds.ls(selection=True) or []
        return {
            "file": cmds.file(query=True, sceneName=True) or None,
            "modified": bool(cmds.file(query=True, modified=True)),
            "nodes": len(cmds.ls()),
            "selection": selection[:20],
        }
    except BaseException:
        return None


def main():
    import maya.standalone
    maya.standalone.initialize(name="python")
    import maya.cmds as cmds  # noqa: F401  (proves the import path works)

    _emit({
        "event": "ready",
        "pid": os.getpid(),
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "appDir": os.environ.get("MAYA_APP_DIR") or None,
        "elapsedMs": 0,
        "scene": _scene_state(),
    })

    namespace = {"__name__": "__dsh_maya_session__", "__doc__": None}

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception:
            continue

        request_id = request.get("id")
        if request.get("action") == "shutdown":
            _emit({"id": request_id, "ok": True, "stdout": "", "stderr": "", "event": "bye", "scene": _scene_state()})
            return 0

        code = request.get("code", "")
        captured_out, captured_err = io.StringIO(), io.StringIO()
        started = time.time()
        ok, error = True, None
        sys.stdout, sys.stderr = captured_out, captured_err
        try:
            exec(compile(code, "<dsh-maya-session>", "exec"), namespace)
        except BaseException:
            ok = False
            error = traceback.format_exc()
        finally:
            sys.stdout, sys.stderr = _real_stdout, _real_stderr

        _emit({
            "id": request_id,
            "ok": ok,
            "stdout": captured_out.getvalue(),
            "stderr": captured_err.getvalue(),
            "error": error,
            "elapsedMs": int((time.time() - started) * 1000),
            "scene": _scene_state(),
        })

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BaseException:
        _emit({"event": "fatal", "error": traceback.format_exc()})
        sys.exit(1)
