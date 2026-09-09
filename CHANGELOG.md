# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/juewee/dsh-plugin-maya/releases/tag/v0.1.0
