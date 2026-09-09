# Design

This document explains how `dsh-plugin-maya` is built and why. For usage, see the
[README](../README.md); for the tool surface, see [tools.md](tools.md).

## Goal

Make a DeepSeek Harness agent competent at Maya Python work, with three properties:

1. **Grounded** — command names, flags and return shapes come from the official
   Autodesk documentation, not from model memory.
2. **Verifiable** — the agent can run what it writes, headlessly first and then in
   the user's live Maya, and read the result.
3. **Cheap** — a multi-megabyte documentation corpus must never be poured into the
   context window, and the fixed per-request cost of the plugin must stay small.

## Why a plugin instead of skills that grep JSON

The upstream `maya-doc` project exposed its documentation through skills whose
instructions were, essentially, *"never read this 1.3 MB JSON; grep it instead"*.
That works, but it pushes retrieval work onto the model:

| grep-the-JSON skill | this plugin |
|---|---|
| Model must know the file layout and craft the right pattern | `maya_doc_search` ranks exact name → prefix → substring → description |
| Raw JSON lines land in context | bounded, human-readable rows with summaries |
| Category browsing is a second grep plus manual extraction | `maya_doc_categories` returns the tree with counts |
| No execution channel | `maya_cmd` / `maya_standalone` close the loop |
| Instructions can be ignored | tools are part of the contract, and the skill tells the model *when* to call them |

The skills were kept, but only for the part they are good at: judgement, workflow
and code patterns.

## DSH integration points

### 1. Plugin contract

`lib/index.js` exports the three things the Cordis loader needs:

```js
export const name = 'dsh-plugin-maya'
export const inject = ['tools']          // wait for the tool registry
export function apply(ctx, config = {}) { /* register tools */ }
```

There is deliberately **no exported `Config` schema**. A schemastery config schema
would be validated by the loader and would add a runtime import of
`@deepseek-ai/schemastery`; instead `resolveConfig()` applies defaults and the tools
fail with actionable messages when a path is wrong. This is what keeps the plugin
loadable from a bare `file://` URL with no installed dependencies.

### 2. Tool contract

Each tool is a plain object the registry accepts:
`{ name, description, parameters, output: { schema, render }, execute, ... }`.
`lib/schema.js` provides a `defineTool` equivalent that:

- validates model arguments against the raw JSON Schema **before** the body runs
  (the official `defineTool` compiles its DSL to the same raw shape, so the wire
  contract is identical);
- produces the same `ToolArgsError`-style message on invalid input;
- honours `isConcurrencySafe` so read-only documentation tools can overlap with
  sibling calls while the two execution tools stay exclusive.

Schemas are written as raw JSON Schema rather than the `defineTool` DSL because the
DSL would reintroduce a runtime dependency for no behavioural gain at this size.

### 3. Skill provider

The skills in `skills/` are installed into a filesystem skill root and discovered by
`@deepseek-ai/dsh-skill-filesystem`. Discovery is one level deep
(`<root>/<name>/SKILL.md`), parses YAML frontmatter, and ranks roots:

| Rank | Source | Path |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | configured `customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |

`scripts/install-skills.mjs` defaults to rank 100 (the project root is the nearest
ancestor containing `.git`, otherwise the working directory). Skills reach the session
catalog without any plugin installation, which is why the *knowledge* is available even
before the tools are mounted.

### 4. Profile patch layer

A DSH profile composes an entry tree from bundle patches, then the profile's
`cordis.patch.yml`, then the home-level patch, then `--patch` overlays. The web profile
uses `patchReload: live`, so writing a patch row hot-loads the plugin into a running GUI.
`scripts/enable.mjs` appends:

```yaml
- insert:
    - id: maya
      name: 'file:///D:/.../dsh-plugin-maya/lib/index.js'
      config: { ... }
```

Relative entry names in `insert` rows are anchored to the patch file's directory and
converted to `file://` URLs by the boot layer; an absolute `file://` URL works directly.
The optional `debugLogPath` appends one JSON line from `apply()`, which is how a mount
can be proven without reading host process logs.

## Command-port protocol

Maya's command port executes whatever Python text arrives on the socket and echoes
Script Editor output back. There is no framing, so the naive implementation
(`send`, `recv(4096)` once) loses output and hangs on exceptions. This client adds
framing:

1. **Wrap.** The user's code is embedded in a generated program that executes it and
   then *always* prints a random sentinel:

   ```python
   import traceback as _dsh_tb
   _dsh_src = "<json-escaped user code>"
   _dsh_ok = 1
   try:
       exec(compile(_dsh_src, "<dsh-maya>", "exec"), {"__name__": "__dsh_maya__"})
   except BaseException:
       _dsh_ok = 0
       print(_dsh_tb.format_exc())
   print("__DSH_MAYA_DONE_<hex>__" + str(_dsh_ok))
   ```

2. **Flatten.** The whole program is base64-encoded into a *single* Python statement
   (`exec(compile(__import__('base64').b64decode('...').decode('utf-8'), ...))`).
   One line means no newline/quote/encoding escaping problems at the socket, and
   base64 is ASCII-safe for both the `python` port type and the MEL wrapper variant.

3. **Read to sentinel.** The client accumulates until the sentinel appears, then
   returns everything before it. The sentinel's trailing digit carries success or
   failure, so a traceback becomes `maya_cmd FAILED` plus the stack instead of a
   timeout.

Cancellation is cooperative: an aborted call destroys the socket and reports
`aborted by caller`, but code already running inside Maya keeps running — the client
cannot reach into Maya's main thread.

## Standalone runner

`mayapy.exe` is Maya's Python interpreter with `maya.standalone` available.
`lib/standalone.js`:

- detects the interpreter (`config.mayapy` → `DSH_MAYA_MAYAPY` → `D:\losheep\tools\Maya\Maya*\bin`
  → `C:\Program Files\Autodesk\Maya*\bin` → `PATH`);
- writes inline `code` to a temp file and spawns it with `PYTHONIOENCODING=utf-8`;
- caps stdout/stderr at 256 KiB each so a runaway loop cannot flood the context;
- kills the child on timeout or abort and reports partial output;
- returns `{ ok, exitCode, stdout, stderr, truncated, elapsedMs }`.

Because it is a real Maya without a GUI, it is the right gate before touching a user's
scene — and the right place to assert behaviour with `print("RESULT", ...)` lines.

## Documentation store

`lib/maya-docs.js` reads `data/<version>/index.json` and
`data/<version>/maya_commands_python.json` lazily, once per process per version, into
two Maps (name → index entry, name → doc body). Search scores each command:

| Score | Condition |
|---|---|
| 1000 | exact name |
| 800 − offset | name prefix |
| 600 − position | name substring |
| 300 | description/category contains the query |
| 200 | all whitespace-split tokens appear |

Ties break alphabetically. Descriptions are flattened and cut to one line
(`summarize()`), examples are truncated per call (`maxExampleChars`), and a command
whose doc page 404'd is reported with `error: "HTTP 404"` rather than as unknown.

## Error taxonomy

| Situation | Surface |
|---|---|
| Maya port closed | `MayaPortUnavailableError` naming host:port and the exact `cmds.commandPort(...)` line |
| Payload raised inside Maya | successful call with `ok: false` and the traceback in the output |
| Payload exceeded `timeoutMs` | `ok: false` with partial output plus a timeout note |
| `mayapy` missing | error telling the model to set `config.mayapy` or `DSH_MAYA_MAYAPY` |
| Docs root missing/unreadable | error naming the directory and the offending code |
| Unknown doc version | error listing the versions actually present |
| Invalid model arguments | `invalid arguments: arguments.<field> ...` before the body runs |

## Testing

`test/smoke.mjs` is an integration test, not a unit test: it mounts
`@deepseek-ai/dsh-system-prompt` and `@deepseek-ai/dsh-tools` in a real Cordis
`Context`, mounts this plugin, and dispatches calls through `ctx.tools.execute`, so
schema projection, argument validation and the result pipeline are all exercised.

The command-port checks run against a **fake Maya**: a TCP server that decodes the
base64 payload this client sends and executes it with a real Python interpreter. That
proves the generated wrapper, the sentinel protocol, stdout capture and traceback
capture without needing Maya to be running. The standalone check runs real
`mayapy.exe` when it exists and is skipped (not failed) otherwise, so the suite is
CI-runnable.

## Deliberate non-goals

- **No browser bridge.** The upstream `ws-maya-proxy.js` + control HTML page were not
  ported: the model drives Maya through the tool pipeline instead.
- **No crawler.** Refreshing the corpus is `scripts/sync-docs.mjs` against a
  `maya-doc` checkout; scraping Autodesk is a separate, network-bound concern.
- **No viewport capture.** A `maya_playblast` tool returning an image would close the
  visual loop; it is the most valuable next addition.
