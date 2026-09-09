# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-09

### Added

- **`maya_session`** — a persistent headless Maya: one `mayapy.exe` process driven
  over stdin/stdout with a sentinel-framed JSON protocol (`lib/session-driver.py`,
  `lib/session.js`). Namespace, imports and the loaded scene survive between calls,
  so a scene can be opened, inspected (Outliner walk), edited and saved across many
  calls while paying Maya's ~5s startup once. Actions: `run`, `start`, `status`, `stop`.
- `cleanPrefs` option for `maya_standalone` (default **true**): points `MAYA_APP_DIR`
  at an empty directory, which skips the user's `userSetup.py`, roughly halves
  startup (measured 11.5s → 5.0s) and makes verification reproducible.
- `examples/walk-scene.mjs` — open any `.ma`/`.mb` headlessly and print its Outliner tree.
- `examples/edit-scene.mjs` — open, edit, save to a new file and verify, without
  touching the input.

### Changed

- `maya_status` also reports whether a persistent session is running.
- Test harness covers the session end to end: state persistence, building and saving
  a scene, opening a `.ma`, walking the DAG, reading attributes, and stop/cleanup.

## [0.1.0] - 2026-09-09

### Added

- DSH plugin (`lib/index.js`) registering six tools on `ctx.tools`:
  `maya_status`, `maya_doc_search`, `maya_doc_get`, `maya_doc_categories`,
  `maya_cmd` and `maya_standalone`.
- Offline Maya command documentation store for Maya 2020 / 2022 / 2025
  (4 523 commands) with ranked search and a category tree.
- Sentinel-framed Maya command-port client: single-line base64 payload,
  captured stdout, captured tracebacks, timeouts and cooperative cancellation.
- Headless `mayapy.exe` runner with stream caps, wall-clock timeout,
  kill-on-timeout and automatic interpreter detection.
- Two DSH skills: `maya-script-dev` (workflow) and `maya-script-templates`
  (ten copy-ready `maya.cmds` patterns).
- Scripts: `sync-docs`, `install-skills`, `enable`, `link-dsh-modules`.
- End-to-end test harness that mounts the plugin into a real Cordis context and
  runs the real DSH tool pipeline (`test/smoke.mjs`).

[0.2.0]: https://github.com/juewee/dsh-plugin-maya/releases/tag/v0.2.0
[0.1.0]: https://github.com/juewee/dsh-plugin-maya/releases/tag/v0.1.0
