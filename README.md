# dsh-plugin-maya

[![ci](https://github.com/juewee/dsh-plugin-maya/actions/workflows/ci.yml/badge.svg)](https://github.com/juewee/dsh-plugin-maya/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that makes a
DSH agent good at Maya Python work: it ships the **offline Autodesk `maya.cmds`
documentation**, a **live channel into a running Maya**, and a **headless `mayapy`
runner** so a script can be proven before it is handed over.

It is the [maya-doc](https://github.com/juewee/maya-doc) project rebuilt as a native DSH
plugin: its skills became DSH skills, its "grep this 1.3 MB JSON" guidance became ranked
tools, and its socket scripts became one framed command-port client.

English | [中文](README.zh.md)

## Tools

| Tool | Purpose |
|---|---|
| `maya_status` | mayapy path/version, command-port reachability, installed doc versions |
| `maya_doc_search` | ranked search over ~1500 commands per version, optional category filter |
| `maya_doc_get` | full entry for up to 8 commands: description + verbatim official examples + URL |
| `maya_doc_categories` | category → subcategory → command counts, for browsing by topic |
| `maya_cmd` | run Python inside a **running** Maya over its command port; captured stdout + tracebacks |
| `maya_standalone` | run a script headlessly with `mayapy.exe`; stdout/stderr/exit code |
| `maya_session` | one persistent headless Maya across calls: build/open a scene, walk the Outliner, edit and save |

Two skills ship alongside them and are picked up by the DSH skill catalog without any
plugin installation:

| Skill | Content |
|---|---|
| `maya-script-dev` | the workflow: which tool when, version differences, command-port setup, standalone pitfalls, script style |
| `maya-script-templates` | ten copy-ready patterns (create/transform, queries, modeling, keyframes, file I/O, attributes, shading, deformers, UI, batch) |
| `maya-anim-curve-diagnostics` | measure bounce / overshoot / jerk per animation channel, then reshape it into a five-key exponential ease |

## Animation curve tool

`scripts/anim_curve_tool.py` is a standalone, dependency-free module for
diagnosing stiff animation curves and reshaping them. It runs in the Script
Editor, through `maya_cmd`, or under `mayapy`.

```python
import sys; sys.path.insert(0, r"<plugin>/scripts")
import anim_curve_tool as act

act.inspect()                                       # per channel: bounce, overshoot, max_jerk
act.unflatten_ends("Camera_Global.rotateZ", apply=True)   # endpoints off 0 degrees
act.fit_exp("Camera_Global.rotateZ", 101, 151, 206)       # dry run: print the plan
act.fit_exp("Camera_Global.rotateZ", 101, 151, 206, apply=True)
```

`inspect` localises the visible kink to an exact frame via `max_jerk_frame`;
`fit_exp` solves `y(u) = A*exp(k*u) + B` through three anchor frames and writes
an exact five-key ease with analytic tangent handles. Measured on a real camera
channel: `max_jerk` 0.0386 → 0.0165, monotonic, no overshoot, fully editable.
Every mutating helper defaults to a dry run and is undoable as one chunk.

## Install

```powershell
git clone https://github.com/juewee/dsh-plugin-maya.git
cd dsh-plugin-maya

node scripts/sync-docs.mjs        # 1. copy the scraped docs out of a maya-doc checkout
node scripts/install-skills.mjs   # 2. install the skills into <project>/.dsh/skills
node scripts/enable.mjs           # 3. mount the plugin in the web profile (hot-loads)
```

The repository already contains the documentation data, so step 1 is only needed to
refresh it. Step 3 appends one `insert` row to `$DSH_HOME/profiles/web/cordis.patch.yml`
referencing the plugin by `file://` URL — no pnpm, no `node_modules`, no restart. Use
`--dry-run` to preview.

Requirements: Node 20+, DSH with the `web` profile, and Maya installed for the execution
tools (`maya_standalone` needs `mayapy.exe`; `maya_cmd` needs a Maya with
`cmds.commandPort(name=":6000", sourceType="python")` open).

## Quick start

Once mounted, a Maya task looks like this:

```
maya_status                                  → what can I run?
maya_doc_search "blendShape"                 → which command, which category?
maya_doc_get ["blendShape", "setKeyframe"]   → exact flags + official examples
maya_standalone <script>                     → does it actually run in a fresh scene?
maya_session  <open a .ma, walk the DAG, edit, save>   → multi-step work, Maya starts once
maya_cmd <probe>                             → is it right in the user's live scene?
```

Under PTC mode the same calls are `await tools.maya_doc_search({ query: 'blendShape' })`
inside `run_code`.

## Layout

```
dsh-plugin-maya/
├── lib/                     plugin runtime (zero dependencies)
│   ├── index.js             entry: name / inject / apply + the six tools
│   ├── schema.js            defineTool equivalent + JSON Schema argument validation
│   ├── maya-docs.js         lazy cached doc store, ranked search, category tree
│   ├── command-port.js      sentinel-framed Maya command-port client
│   ├── standalone.js        mayapy runner + interpreter detection
│   ├── session.js           persistent headless Maya client
│   └── session-driver.py    in-process driver for that session
├── skills/                  DSH skills (installed into <project>/.dsh/skills)
├── data/                    Maya 2020 / 2022 / 2025 documentation + MANIFEST.json
├── docs/                    design, tool reference, configuration, data
├── scripts/                 sync-docs · install-skills · enable · link-dsh-modules
│   └── anim_curve_tool.py   animation-curve inspector + exponential-fit reshaper
├── examples/                walk-scene.mjs · edit-scene.mjs (standalone, no DSH host)
├── test/smoke.mjs           integration test (real Cordis + real tool registry)
├── test/anim_curve_tool_test.py   mayapy test for the animation curve tool
└── .github/workflows/ci.yml
```

## Documentation

| Document | Contents |
|---|---|
| [docs/design.md](docs/design.md) | architecture, DSH integration points, command-port protocol, testing strategy |
| [docs/tools.md](docs/tools.md) | every tool: parameters, returns, example output, error behaviour |
| [docs/configuration.md](docs/configuration.md) | configuration fields, install variants, verification, troubleshooting |
| [docs/data.md](docs/data.md) | data provenance, JSON structure, refresh procedure |
| [CHANGELOG.md](CHANGELOG.md) | release history |

## Verification

`npm test` mounts the plugin into a real Cordis context with the real
`@deepseek-ai/dsh-tools` registry and dispatches through `ctx.tools.execute`, so schema
projection, argument validation and result rendering are all exercised. `maya_cmd` is
tested against a fake command port whose "Maya" is a real Python interpreter running the
payload the client sends; `maya_standalone` and `maya_session` run real `mayapy.exe` when
it is installed and are skipped otherwise, which keeps the suite CI-runnable. The
session checks build a scene, save it, open it in a new scene, walk the DAG and read
attributes back.

```powershell
npm install   # devDependencies only: cordis, dsh-system-prompt, dsh-tools
npm test
```

## Limitations

- The command port is **unauthenticated and localhost-only** — never expose it.
- `maya_cmd` code runs on Maya's main thread; a long payload blocks the UI, and the
  client can time out but cannot cancel code already running inside Maya.
- `maya_cmd` is a live-scene channel by design and is not sandboxed — use
  `maya_standalone` for unattended work.
- The documentation is a static snapshot; refresh it with `scripts/sync-docs.mjs`.
- No viewport capture yet. A `maya_playblast` tool returning an image is the most
  valuable next addition.

## Credits

Documentation data is scraped from Autodesk's public Maya CHS Tech-Docs by
[maya-doc](https://github.com/juewee/maya-doc). The MIT license here covers the plugin
code, not the scraped content.

## License

[MIT](LICENSE)
