# Tool reference

Seven tools are registered on `ctx.tools`. Every one returns a bounded text
projection (`report`) plus a canonical JSON value, so a UI can render either.

Under PTC mode they are reachable as `await tools.maya_doc_search({...})` inside
`run_code`; in native mode they are ordinary model-facing tools. Read-only tools
declare `isConcurrencySafe`, so independent lookups may run in parallel.

---

## `maya_status`

What can this session actually do? Call it once at the start of a Maya task.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `probe` | boolean | no | `true` | also probe mayapy and the command port; `false` only reports configured paths |

Returns: `{ report, mayapy, mayapyAvailable, commandPort: { host, port, reachable }, session, docsRoot, versions: [{ version, commands }] }`

```
mayapy: D:/losheep/tools/Maya/Maya2025/bin/mayapy.exe — 3.11.4 (tags/v3.11.4:d2340ef, ...)
command port: 127.0.0.1:6000 — not reachable (ECONNREFUSED)
docs root: D:/losheep/project/AI/dsh-work-table/dsh-plugin-maya/data
docs: Maya 2025 (1521 commands), Maya 2022 (1503 commands), Maya 2020 (1499 commands) | default 2025
```

Never fails for a missing mayapy or a closed port — those are reported, not thrown.

---

## `maya_doc_search`

Ranked search over the offline command documentation.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `query` | string | **yes** | — | command name fragment or topic keyword |
| `version` | string enum | no | `defaultVersion` | `"2020" \| "2022" \| "2025"` |
| `category` | string | no | — | case-insensitive substring filter over category/subcategory |
| `limit` | integer | no | `15` | 1–50 rows |

Returns: `{ report, version, total, matched, results: [{ name, categories, isMelScript, summary, hasExamples, url, error }] }`

```
Maya 2025 docs — 5 match(es) for "blendShape" of 1521 commands (showing 4)
- blendShape  [Animation / Object Deformation] (examples)
    In the create mode the first item on the selection list is treated as the base...
- blendShapePanel  [Animation / Object Deformation] (examples)
    ...
```

Ranking: exact name → name prefix → name substring → description/category → all tokens.
`isMelScript` marks MEL scripts callable through `cmds`; `error` marks commands whose
Python page 404'd (they still exist).

---

## `maya_doc_get`

Full entry for named commands: description, verbatim official Python examples, category, URL.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `names` | string[] | **yes** | — | 1–8 command names, with or without the `cmds.` prefix |
| `version` | string enum | no | `defaultVersion` | documentation version |
| `maxExampleChars` | integer | no | `2500` | per-command example truncation (200–20000) |

Returns: `{ report, version, commands: [{ name, known, categories, isMelScript, description, examples, url, error }] }`

```
### addAttr  (Maya 2025)
category: General / Node Attributes | MEL script
description: This command is used to add a dynamic attribute to a node or nodes...
examples:
import maya.cmds as cmds
cmds.sphere(name='earth')
cmds.addAttr(longName='mass', defaultValue=1.0)
url: https://help.autodesk.com/cloudhelp/2025/CHS/Maya-Tech-Docs/CommandsPython/addAttr.html
```

An unknown name yields `not found in the Maya <version> documentation index` instead of an error.

---

## `maya_doc_categories`

Category tree with command counts, for browsing when no command name is known.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `version` | string enum | no | `defaultVersion` | documentation version |

Returns: `{ report, version, categories: [{ category, commandCount, subcategories: [{ subcategory, commandCount }] }] }`

```
Maya 2025 command categories
- General (309)
    Interactive tools (130)
    General Interest Utilities (105)
    Node Attributes (44)
- Modeling (271)
    Polygon Meshes (146)
    ...
```

A command may appear under several subcategories (for example `curveRGBColor`), so the
sum of counts exceeds the number of commands.

---

## `maya_cmd`

Execute Python inside a **running** Maya GUI over its command port and return the captured output.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `code` | string | **yes** | — | Python source; `maya.cmds` is **not** pre-imported |
| `host` | string | no | config host | command port host |
| `port` | integer | no | config port | command port number |
| `timeoutMs` | integer | no | `20000` | 500–600000 ms |

Returns: `{ report, ok, output, truncated, elapsedMs, host, port }`

```python
import maya.cmds as cmds
print("meshes:", len(cmds.ls(type="mesh")))
print("exists:", cmds.objExists("energy_core"))
```

```
maya_cmd ok — 127.0.0.1:6000 in 42ms
meshes: 17
exists: True
```

A raised exception returns `maya_cmd FAILED` with the formatted traceback and `ok: false`;
a closed port raises an error naming the exact `cmds.commandPort(name=":6000", sourceType="python")`
line to run in Maya. Code runs on Maya's main thread, so keep probes short.

---

## `maya_standalone`

Run a Maya script headlessly with `mayapy.exe` and return stdout, stderr and the exit code.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `script` | string | one of | — | absolute path to an existing `.py` file |
| `code` | string | one of | — | inline source, written to a temp file and run |
| `args` | string[] | no | `[]` | extra argv passed to the script |
| `mayapy` | string | no | auto-detected | override the interpreter for this call |
| `cwd` | string | no | — | working directory for the child process |
| `cleanPrefs` | boolean | no | `true` | isolate Maya preferences via `MAYA_APP_DIR` |
| `timeoutMs` | integer | no | `300000` | 1000–3600000 ms |

Returns: `{ report, ok, exitCode, stdout, stderr, truncated, elapsedMs, scriptPath, mayapy }`

```
maya_standalone ok — exit 0 in 5012ms
mayapy: D:/losheep/tools/Maya/Maya2025/bin/mayapy.exe
script: C:/Users/.../Temp/dsh-maya-standalone/dsh_maya_1788968087321_5kad7a.py
prefs: isolated (userSetup.py skipped)
--- stdout ---
created: ['DshTestCube', 'polyCube1'] ['DshTestSphere', 'polySphere1']
meshes: 2
exists: True
```

Streams are capped at 256 KiB each; a timeout kills the child and reports partial output
with `ok: false` and `exitCode: null`.

`cleanPrefs` (default true) points `MAYA_APP_DIR` at an empty directory, so the user's
preferences and `Documents/maya/scripts/userSetup.py` are not loaded. That makes runs
reproducible and roughly twice as fast (measured 11.5s → 5.0s). Pass `cleanPrefs: false`
when the script needs the user's plugins, shelves or environment set up by `userSetup.py`.

---

## `maya_session`

One **persistent** headless Maya: the same `mayapy.exe` process answers every call, so
imports, variables and the loaded scene survive between them. Use it for multi-step work
against a scene; use `maya_standalone` for a one-shot script in a pristine interpreter.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `action` | string enum | no | `"run"` | `"run" \| "start" \| "status" \| "stop"` |
| `code` | string | for `run` | — | Python source; `maya.cmds` is already imported as `cmds` |
| `mayapy` | string | no | auto-detected | interpreter override (`start`) |
| `cleanPrefs` | boolean | no | `true` | isolate preferences (`start`) |
| `timeoutMs` | integer | no | `60000` run / `180000` start | 500–900000 ms |

Returns: `{ report, ok, stdout, stderr, error, elapsedMs, scene, session }`

```python
# call 1 — run starts the session automatically
import maya.cmds as cmds
cmds.file(new=True, force=True)
rig = cmds.group(em=True, name="rig")
body = cmds.polyCube(name="body")[0]
cmds.parent(body, rig)
cmds.file(rename="C:/tmp/demo.ma")
cmds.file(save=True, type="mayaAscii")
```

```python
# call 2 — different call, same Maya, same scene
print(cmds.file(query=True, sceneName=True))          # C:/tmp/demo.ma
print(cmds.listRelatives("rig", children=True))       # ['body']
```

```
maya_session run ok — 14ms
C:/tmp/demo.ma
['body']
scene: C:/tmp/demo.ma | nodes: 56
```

An Outliner walk is just Python:

```python
def walk(node, depth=0):
    print("  " * depth + "- " + node + " [" + cmds.nodeType(node) + "]")
    for child in cmds.listRelatives(node, children=True, fullPath=False) or []:
        walk(child, depth + 1)

for root in cmds.ls(assemblies=True):
    walk(root)
```

Real output against Maya's own example rig (`Examples/Animation/Rigs/M4Y4-B07.ma`,
877 nodes, 55 meshes, 137 joints):

```
- m4y4_GEO_GRP [transform]
  - head [transform]
  - torso [transform]
  - L_arm [transform]
  - R_arm [transform]
- M4Y4_rig_Guides [joint]
  - Head [joint]
  - Hips [joint]
  - LeftArm [joint]
```

Behaviour and limits:

- `run` auto-starts a session when none is running, and says so in the report.
- The session is a **private** Maya: it cannot see the user's open GUI scene. Use
  `maya_cmd` for the live session, or open the saved file here.
- Opening a file replaces the session scene. Saving into a new path needs
  `cmds.file(rename=path)` before `cmds.file(save=True, ...)`; saving with a path and
  `save=True` raises Maya's "cannot specify a filename with -save" error.
- A call that exceeds `timeoutMs` **kills** the session (Python cannot be interrupted
  safely); the next `run` starts a fresh one, so treat long loops as fatal.
- `status` is cheap and reports pid, uptime, interpreter, scene and any stderr tail.
- The session stops on plugin dispose, on `action: "stop"`, and on timeout/abort.

Two runnable examples ship in `examples/`: `walk-scene.mjs` (open a `.ma`/`.mb` and
print its Outliner tree) and `edit-scene.mjs` (open, edit, save to a new file, verify).
They drive `lib/session.js` directly, without a DSH host.
