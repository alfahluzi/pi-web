# Web panels

A Pi package can add a button to pi-web's chat top bar and open its own UI in the
right panel — no change to pi-web's source, and no rebuild. The panel is an
ordinary HTML document served from the package itself and embedded in a
sandboxed iframe, so it can be written with any framework (or none).

This is how the Project Plan Manager and similar tools are meant to live outside
the pi-web checkout. A runnable example is in
[`examples/web-panel-plugin`](../examples/web-panel-plugin).

## Declare a panel

Add a `piWeb` field to the package's `package.json`:

```json
{
  "name": "@you/pi-plan-manager",
  "version": "1.0.0",
  "piWeb": {
    "panels": [
      {
        "id": "plan",
        "title": "Project Plan",
        "icon": "clipboard",
        "entry": "panel/index.html",
        "order": 10
      }
    ]
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique panel id: `[a-z0-9][a-z0-9._-]*`, max 64 chars, case-insensitive. Used as the first segment of the asset URL. |
| `title` | no | Button and tab label. Defaults to `id`. Max 80 chars. |
| `entry` | yes | Package-relative path to the HTML document. Must end in `.html`/`.htm` and stay inside the package. |
| `icon` | no | Named icon (see below). Defaults to the puzzle icon. |
| `iconSvgPath` | no | A 24×24 path `d` string for custom artwork. Validated server-side; wins over `icon`. |
| `order` | no | Sort position in the top bar; lower first. Ties break by title. |

Named icons: `plugin`, `clipboard`, `list`, `folder`, `file`, `globe`,
`terminal`, `settings`, `table`, `calendar`, `chart`, `code`, `book`,
`sparkles`, `layers`, `git-branch`, `database`, `external-link`, `message`,
`lightbulb`, `rocket`, `search`, `box`.

Malformed panels are skipped with a diagnostic; they never break the rest of the
package listing.

## How the document is served

The entry and every asset it references are served from the package directory
through `/api/web-panels/<id>/<path>`. Relative references work naturally:

```html
<link rel="stylesheet" href="./style.css" />
<script src="./app.js"></script>
```

resolves to `/api/web-panels/plan/panel/style.css` and
`/api/web-panels/plan/panel/app.js`. Paths are checked both lexically and after
`realpath`, so a panel cannot read outside its own package.

Only panels from **installed Pi packages** are discovered:

- `pi install npm:@you/pi-plan-manager`
- `pi install ./pi-plan-manager` (local path)
- `pi install git:github.com/you/pi-plan-manager@v1`

Project-scoped packages (`--local`, `.pi/settings.json`) appear only after the
project is trusted. A package disabled in the Plugins panel is hidden entirely,
including its panel.

The list is rebuilt by `/api/web-panels` — always with a fresh scan, so
installing or removing a package is reflected on the next fetch. Open tabs keep
their document and adopt manifest changes (title, url, icon) in place.

## Context

pi-web appends the active context to the document URL and re-sends it over
`postMessage` whenever the workspace, session or theme changes:

```
/api/web-panels/plan/panel/index.html?cwd=/work/project&sessionId=…&theme=dark
```

Read the query string for the first paint, then listen for updates:

```js
window.addEventListener("message", (event) => {
  const data = event.data;
  if (data?.type !== "pi-web:context") return;
  // data.cwd, data.sessionId, data.theme
});
```

## Panel → pi-web messages

`window.parent.postMessage({ type, ... }, "*")`:

| Type | Payload | Effect |
| --- | --- | --- |
| `pi-web:ready` | — | Ask the host to (re)send `pi-web:context`. Useful if the script attaches its listener late. |
| `pi-web:open-file` | `path` | Open a file in the right panel. Relative paths resolve against the active workspace; absolute paths pass through. |
| `pi-web:insert-prompt` | `text` | Append text to the chat composer. |
| `pi-web:set-title` | `title` | Rename the panel tab (wins over the manifest title until the panel reloads). |

Only same-origin messages from the panel's own frame are accepted.

## Trust model

A panel runs in the app's origin (`sandbox="allow-scripts allow-same-origin"`),
so it can call pi-web's APIs with the session cookie. This is the same trust
level as a package's Node extension, which already runs arbitrary code on the
server — treat installing a package as trusting it. The panel assets are
live-read from the package on every request (`no-store`), so editing a panel
while `npm run dev` runs shows up on reload.

## Reading workspace files

A panel has no server of its own, but it can read the workspace through pi-web's
generic file API (same allowed-roots rules as the file viewer):

```js
// List a directory
const res = await fetch(`/api/files/${encodePath(dir)}?type=list`, { cache: "no-store" });
const { entries } = await res.json(); // [{ name, isDir, size, modified }]

// Read a text file (content is capped at 256 KB per call; page with ?offset=)
const read = await fetch(`/api/files/${encodePath(file)}?type=read`, { cache: "no-store" });
const { content, truncated, nextOffset } = await read.json();
```

Encode an absolute path the way `lib/file-paths.ts#encodeFilePathForApi` does:
split on `/`, drop empty segments, and `encodeURIComponent` each one (a literal
`//` UNC prefix folds into the first segment).

The
[`project-plan-manager`](https://github.com/alfahluzi/project-plan-manager)
panel is the reference implementation: `panel/ppm-data.js` walks up from `cwd` to
find `.ppm`, reads the plan files, and rebuilds the CLI's `/api/tasks` payload
client-side.

## Try the example

```bash
pi install ./examples/web-panel-plugin
```

The next time pi-web fetches `/api/web-panels` (workspace switch, reopening
Settings, or a page reload) an **Example Panel** button appears in the top bar.
Remove it with `pi remove ./examples/web-panel-plugin`.
