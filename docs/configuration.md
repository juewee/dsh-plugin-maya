# Configuration and installation

## Configuration

The plugin is configured through the `config` block of its patch row. Every field is
optional; defaults are resolved in `resolveConfig()` (`lib/index.js`).

| Field | Type | Default | Meaning |
|---|---|---|---|
| `docsRoot` | string | `<plugin>/data` | directory containing `<version>/index.json` and `<version>/maya_commands_python.json` |
| `defaultVersion` | string | `"2025"` | version used when a tool call omits `version` |
| `mayapy` | string | auto-detected | explicit `mayapy.exe` path |
| `commandPortHost` | string | `"127.0.0.1"` | Maya command port host |
| `commandPortPort` | number | `6000` | Maya command port port |
| `melWrapper` | boolean | `false` | wrap the payload in MEL `python("...")` — only for ports opened with `sourceType="mel"` |
| `maxExampleChars` | number | `2500` | default per-command example truncation |
| `debugLogPath` | string | — | optional JSONL log of load/unload and tool usage |

Environment variables:

| Variable | Effect |
|---|---|
| `DSH_MAYA_MAYAPY` | mayapy path used when `config.mayapy` is unset |
| `DSH_HOME` | used by `scripts/enable.mjs` to locate the profile |

mayapy auto-detection order: `config.mayapy` → `DSH_MAYA_MAYAPY` →
`D:\losheep\tools\Maya\Maya*\bin\mayapy.exe` → `C:\Program Files\Autodesk\Maya*\bin\mayapy.exe` → `PATH`.

## Install

```powershell
cd dsh-plugin-maya

node scripts/sync-docs.mjs        # 1. copy the scraped docs out of a maya-doc checkout
node scripts/install-skills.mjs   # 2. install the skills into <project>/.dsh/skills
node scripts/enable.mjs           # 3. mount the plugin in the web profile (hot-loads)
```

`sync-docs.mjs` defaults to `../maya-doc`; pass `--from <checkout>` for another location.
`install-skills.mjs` defaults to `<plugin>/../.dsh/skills`; pass `--to <dir>`.
`enable.mjs` accepts `--profile <name>`, `--docs-root`, `--mayapy`, `--port`, `--version`
and `--dry-run`.

### What `enable.mjs` writes

```yaml
- insert:
    - id: maya
      name: 'file:///D:/losheep/project/AI/dsh-work-table/dsh-plugin-maya/lib/index.js'
      config:
        docsRoot: 'D:/losheep/project/AI/dsh-work-table/dsh-plugin-maya/data'
        defaultVersion: '2025'
        mayapy: 'D:/losheep/tools/Maya/Maya2025/bin/mayapy.exe'
        commandPortPort: 6000
        debugLogPath: 'D:/losheep/project/AI/dsh-work-table/.dsh/maya-plugin.log'
```

The row is appended to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. Because the web
profile uses `patchReload: live`, the running GUI picks it up without a restart.

### Alternative: install by package name

The plugin has **no runtime dependencies**, so either form works:

```powershell
dsh plugin --profile web add D:\path\to\dsh-plugin-maya
```

then reference it by name in the patch row:

```yaml
- insert:
    - id: maya
      name: 'dsh-plugin-maya'
      config: { ... }
```

The `file://` form needs no pnpm and no profile `node_modules`, which is why it is the
default here.

## Verify the mount

If `debugLogPath` is set, `apply()` appends one line when the plugin loads:

```json
{"time":"2026-09-09T15:35:44.088Z","plugin":"dsh-plugin-maya","event":"loaded","docsRoot":"...","defaultVersion":"2025"}
```

Then ask the agent to call `maya_status` — it reports mayapy, the command port and the
installed documentation versions in one line.

## Disable / uninstall

- **Temporarily:** set `disabled: true` on the `maya` row.
- **Permanently:** delete the `- insert:` block from `cordis.patch.yml`.
- **Skills:** delete `<project>/.dsh/skills/maya-script-dev` and `maya-script-templates`.
- **Data:** `data/` is only used by the doc tools; removing it makes them fail with a
  clear "documentation directory is unreadable" error.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Tools do not appear | the row is in the wrong profile's patch file, or the file failed to parse — YAML must be a top-level array |
| `Maya command port ... not reachable` | open it in Maya: `cmds.commandPort(name=":6000", sourceType="python")`; persist it in `userSetup.py` |
| `mayapy.exe not found` | set `config.mayapy` or `DSH_MAYA_MAYAPY` |
| `documentation directory is unreadable` | run `node scripts/sync-docs.mjs`, or point `docsRoot` at an existing `data` directory |
| `unknown Maya documentation version` | the error lists the versions present under `docsRoot` |
| Test harness cannot resolve `@deepseek-ai/*` | run `node scripts/link-dsh-modules.mjs` or `npm install` (devDependencies) |
| `maya_cmd` times out but Maya is busy | raise `timeoutMs`; the code keeps running inside Maya and cannot be cancelled from here |
| `maya_session` says the session was killed | a call exceeded `timeoutMs`; the next `run` starts a fresh session — keep long work in `maya_standalone` instead |
| Headless run misses a plugin/shelf the script needs | pass `cleanPrefs: false` so the user's `userSetup.py` and preferences load |
