# Documentation data

## Provenance

`data/` is a verbatim copy of the Maya command documentation scraped from the Autodesk
Maya CHS Tech-Docs by the [maya-doc](https://github.com/juewee/maya-doc) project:

```
https://help.autodesk.com/cloudhelp/<version>/CHS/Maya-Tech-Docs/CommandsPython/<command>.html
```

| Version | Indexed commands | With description | With examples | HTTP 404 |
|---|---|---|---|---|
| 2025 | 1521 | 1199 | 1197 | 316 |
| 2022 | 1503 | 1184 | 1182 | 313 |
| 2020 | 1499 | 1180 | 1178 | 313 |

A 404 means the command has no Python-specific documentation page. It still exists and
is callable through `maya.cmds`; the tools report `error: "HTTP 404"` instead of
pretending the command is unknown.

## Layout

```
data/
├── MANIFEST.json                 # source checkout, sync timestamp, per-version stats
├── 2020/{index.json, maya_commands_python.json}
├── 2022/{index.json, maya_commands_python.json}
└── 2025/{index.json, maya_commands_python.json}
```

### `index.json`

Maps a command name to its taxonomy and kind:

```json
{
  "addAttr": { "category": "General", "subcategory": "Node Attributes", "isMelScript": true },
  "curveRGBColor": {
    "categories": [
      { "category": "General", "subcategory": "Display Parameters" },
      { "category": "Animation", "subcategory": "Creating Animation and Manipulating Keyframes" }
    ],
    "isMelScript": true
  }
}
```

### `maya_commands_python.json`

```json
{
  "meta": { "version": "Maya 2025", "total": 1521, "success": 1205, "withDescription": 1199, "withExamples": 1197, "errors": 316 },
  "commands": [
    {
      "name": "addAttr",
      "description": "This command is used to add a dynamic attribute to a node or nodes...",
      "examples": "import maya.cmds as cmds\ncmds.sphere(name='earth')...",
      "url": "https://help.autodesk.com/cloudhelp/2025/CHS/Maya-Tech-Docs/CommandsPython/addAttr.html"
    }
  ]
}
```

Descriptions are capped at 1500 characters and examples at 3000 by the scraper; the
tools truncate further per call.

## Refreshing

```powershell
node scripts/sync-docs.mjs --from D:\path\to\maya-doc
```

The script locates every `maya-<version>-api-doc` directory inside the checkout
(wherever it sits), copies its `data/*.json` into `data/<version>/`, and rewrites
`MANIFEST.json` with command counts, byte sizes and a timestamp. To regenerate the
scrape itself, use the crawler in the `maya-doc` repository.

## How the tools read it

`lib/maya-docs.js` parses each requested version once per process into two Maps and
caches them; nothing is re-read per call, and no raw JSON is ever returned to the model.
Search scoring and truncation rules are documented in [design.md](design.md#documentation-store)
and [tools.md](tools.md).

## Licensing

The JSON contains text scraped from Autodesk's public documentation and is redistributed
here for offline agent use, as in the upstream `maya-doc` project. Autodesk's terms for
that documentation still apply; the MIT license in this repository covers the plugin
code, not the scraped content.
