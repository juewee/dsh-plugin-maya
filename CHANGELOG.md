# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-28

### Added

- **`scripts/anim_curve_tool.py`** — a dependency-free animation-curve inspector
  and reshaper, runnable in the Script Editor, via `maya_cmd`, or under `mayapy`:
  - `inspect()` reports per channel: key count, tangent types and angles,
    negative-velocity frames (bounce), overshoot frames, speed dips, and
    `max_jerk` with the frame it occurs on — which is where a visible hard turn
    actually comes from.
  - `fit_exp(attr, first, mid, last)` solves `y(u) = A*exp(k*u) + B` through
    three anchor frames and rewrites the channel as a five-key exponential ease
    with analytic tangent handles (C1 continuous, no segment seams). Measured on
    a real camera channel: `max_jerk` 0.0386 → 0.0165, monotonic, no overshoot.
  - `unflatten_ends(attr, limit_deg=1.0)` gives a channel's first/last tangent a
    small nonzero angle, where `auto`/`spline`/`clamped` pin the endpoints to
    exactly 0 degrees.
  - Every mutating helper defaults to a dry run, is undoable as one chunk, and
    never touches first/last key values unless asked.
- **`skills/maya-anim-curve-diagnostics`** — the method around the tool: what
  each symptom means, the verified gotchas (clamped pins entry to 0°, moving keys
  cannot fix a value-driven bounce, one tangent angle bends the segment before
  it), and the five-keys-beat-per-frame-baking result.
- **`test/anim_curve_tool_test.py`** — real `mayapy` end-to-end test: builds a
  stiff curve, checks the diagnosis, proves the dry run mutates nothing, applies
  the fit, and asserts monotonicity, preserved anchor values, tangent types and a
  lower `max_jerk`.

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
