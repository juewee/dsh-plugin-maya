---
name: maya-script-dev
description: "Workflow for writing, verifying and delivering Maya Python (maya.cmds) scripts using the dsh-plugin-maya tools: look commands up in the offline Autodesk docs, execute code in a live Maya through its command port, and test headlessly with mayapy. Invoke when the user asks for Maya scripts, maya.cmds usage, rigging/animation/modeling automation, or Maya tool development."
---

# Maya Script Development

How to write Maya Python that actually runs. The `maya_*` tools are the ground truth: **look it up, run it, then deliver it.**

## Tool selection

| Need | Tool |
|---|---|
| What Maya can this session control? | `maya_status` (call once at the start of a Maya task) |
| Does a command exist / exact name / category | `maya_doc_search` |
| Syntax, flags, official Python examples | `maya_doc_get` |
| Browse by topic when no name is known | `maya_doc_categories` then `maya_doc_search` with `category` |
| Run code in the user's running Maya | `maya_cmd` |
| Test a script headlessly in a fresh scene | `maya_standalone` |

## Standard workflow

1. `maya_status` — learn the mayapy path, whether a command port is open, and which doc versions exist.
2. Look up every non-trivial command with `maya_doc_search` / `maya_doc_get`. Do not guess flag names or return-value shapes; the docs contain verbatim examples.
3. Write the script with named nodes and explicit error handling (see below).
4. Verify with `maya_standalone` (headless, safe, repeatable) — assert the result with `print()` lines, then read the captured stdout. This is the cheapest way to prove a script works.
5. If the user has Maya open, verify in their real session with `maya_cmd` (inspect or create, then query back). Warn before destructive operations (delete, `file -new`, batch rename).
6. Deliver the script plus the exact way to run it.

## Doc data

Offline scrape of the Autodesk Maya CHS Tech-Docs: **2020 / 2022 / 2025**, ~1500 commands each, with description + verbatim Python examples + official URL. Default version is 2025; pass `version` when the user targets another release. Differences that matter:

| Version | Note |
|---|---|
| 2020 | no `standardSurface` — use `aiStandardSurface` (Arnold), `lambert`, `blinn` |
| 2022 | full `standardSurface`; improved `polyRetopo` |
| 2025 | newest; `maya.cmds` stays backward compatible |

Commands marked `isMelScript` are MEL scripts wrapped for Python — they work through `cmds` but may behave differently. Some entries carry `HTTP 404`: the command exists but has no Python-specific doc page.

## Running in a live Maya (`maya_cmd`)

The command port must be open in Maya:

```python
import maya.cmds as cmds
cmds.commandPort(name=":6000", sourceType="python")
```

Persist it in `Documents/maya/<version>/scripts/userSetup.py` to have it every launch. Notes:

- `maya.cmds` is **not** pre-imported in the payload — start with `import maya.cmds as cmds`.
- Code runs on Maya's main thread; a long loop blocks the UI. Keep probes short.
- `print()` output and tracebacks come back in the tool result; a raised exception returns `maya_cmd FAILED` with the traceback, which is your debugging loop.
- No authentication: never expose the port beyond localhost.

## Testing headlessly (`maya_standalone`)

```python
import maya.standalone
maya.standalone.initialize(name="python")

import maya.cmds as cmds
# ... work ...
print("RESULT", cmds.ls(type="mesh"))

maya.standalone.uninitialize()
```

- `initialize()` once per process; `uninitialize()` at the end.
- No GUI: `promptDialog`, `fileDialog`, `playblast` windows and other interactive commands fail.
- No default persp/top/front/side cameras in the standalone world.
- Load plugins explicitly with `cmds.loadPlugin(...)` after `initialize()`.
- Print machine-checkable lines (`print("RESULT", value)`) so the captured stdout is easy to assert.

## Script style that survives review

1. `import maya.cmds as cmds` at the top; `import maya.mel as mel` only when needed.
2. Always name nodes (`name="MyCube"`); Maya's auto names (`polyCube1`) are fragile.
3. `cmds.ls()` / `cmds.listRelatives()` can return `None` — use `or []`.
4. Check existence with `cmds.objExists()` before operating.
5. Use full attribute names (`translateX`) unless brevity matters.
6. Wrap risky operations in `try/except` and report via `print` so `maya_standalone` / `maya_cmd` show the failure.
7. Prefer `force=True` on file operations that may overwrite, and never save over the user's scene without saying so.
8. Guard UI code with `cmds.window(name, exists=True)` / `deleteUI` before rebuilding.
9. Return values: most create commands return `[transform, shape]` — take `[0]` for the transform.

## See also

The `maya-script-templates` skill holds copy-ready patterns for modeling, animation, shading, deformers, UI and batch processing.
