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

## Reading the live official page

The corpus is a snapshot. When you need a release it does not contain, a command that
404'd, or an example longer than the crawler's 3000-character cap, read the live Autodesk
page instead. This is an **agent-side fallback**, not a plugin tool: the plugin stays
offline and deterministic, and the model uses its own web tool when it is available.

### URL pattern

```
https://help.autodesk.com/cloudhelp/<VERSION>/<LANG>/Maya-Tech-Docs/CommandsPython/<command>.html
```

| Part | Values |
|---|---|
| `<VERSION>` | `2020` … `2026` all verified reachable (same pattern for other releases) |
| `<LANG>` | `CHS` (Chinese — what this corpus was scraped from) or `ENU` (English); `ENG` returns 404 |
| `<command>` | command name without the `cmds.` prefix, e.g. `polyCube` |

Discovery index for one release (every command, used by the upstream crawler):

```
https://help.autodesk.com/cloudhelp/<VERSION>/CHS/Maya-Tech-Docs/Commands/index_all.html
```

### Page structure

The body has five `<h2>` sections in this order:
**Synopsis · Return value · Related · Flags · Python examples**.

The navigation bar near the top *also* contains the literal text "Python examples", so
anchor on the `<h2>` (or on `name="hExamples"`) rather than on the first text match —
that is the single most common extraction bug.

- **Examples** — the `<pre>` blocks inside the "Python examples" `<h2>` section.
- **Synopsis** — the `<p id="synopsis">` signature (which lists every flag) plus the
  following `<p>` blocks, minus boilerplate.
- **Boilerplate to drop** — `Note: Strings representing object names and arguments must be
  separated by commas.`, `This is not depicted in the synopsis.`, and
  `<command> is (NOT) undoable`.

### Verified extraction (2026-09-09)

Fetching `CHS/2025/CommandsPython/polyCube.html` returned HTTP 200, 24 600 characters,
five `<h2>` sections and one `<pre>` block:

```python
import maya.cmds as cmds

cmds.polyCube( sx=10, sy=15, sz=5, h=20 )
#result is a 20 units height rectangular box
#with 10 subdivisions along X, 15 along Y and 20 along Z.

cmds.polyCube( sx=5, sy=5, sz=5 )
#result has 5 subdivisions along all directions, default size

# query the width of a cube
w = cmds.polyCube( 'polyCube1', q=True, w=True )
```

The same page yields the synopsis signature:

```
polyCube([axis=[linear, linear, linear]], [caching=boolean], ... [width=linear])
```

### Recipe

1. Ask `maya_doc_get` first. If the command is there with an example, stop — the corpus
   is enough and needs no network.
2. Otherwise fetch the URL above (about 24 KB of HTML, well inside tool limits).
3. Extract with the rules above; a regex over `<h2>` and `<pre>` is enough, no DOM library
   is required.
4. Quote the official example **verbatim** and cite the URL in the delivered script.
5. If the page 404s too, the command may be MEL-only or renamed: check `maya_doc_search`
   for a rename and `index_all.html` for the release you target.

Runnable one-liner (Node 20+, no dependencies) for a terminal:

```powershell
node -e "const u='https://help.autodesk.com/cloudhelp/2025/CHS/Maya-Tech-Docs/CommandsPython/polyCube.html';fetch(u).then(r=>r.text()).then(h=>{const s=h.slice(h.search(/<h2[^>]*>\s*<a[^>]*hExamples/i));const t=s.slice(s.indexOf('</h2>')+5);const sec=t.slice(0,t.search(/<h2|<hr\b/i));for(const m of sec.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi))console.log(m[1].replace(/<[^>]+>/g,'').trim())})"
```

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