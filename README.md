# Pi Web (alfahluzi fork)

This repository, [alfahluzi/pi-web](https://github.com/alfahluzi/pi-web), is an unofficial fork of [agegr/pi-web](https://github.com/agegr/pi-web). It includes upstream Pi Web plus the custom features below. The current fork includes upstream v0.15.0 and subsequent fixes through [`b96b28b`](https://github.com/agegr/pi-web/commit/b96b28b).

Upstream retains credit for Pi Web and its core features. The original [MIT license](./LICENSE) remains unchanged.

[中文文档](./docs/README.zh-CN.md) | [日本語](./docs/README.ja.md) | [Русский](./docs/README.ru.md)

Local browser UI for the [pi coding agent](https://github.com/earendil-works/pi). Pi Web uses the same local configuration and session files as pi, so you can browse and resume conversations, run agent turns, configure models and resources, and inspect project files from a browser.

**[Try the upstream interactive demo](https://agegr.github.io/pi-web/)** The upstream Pi Web UI runs entirely in your browser, with sample sessions, files and models. There is nothing to install; replies are pre-written and no model is called. The demo and screenshot below do not showcase this fork's custom features.

![Pi Web displaying a pi session with structured Markdown, tool calls, and project navigation](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## Custom Features

These additions are present in this fork, compared with upstream `agegr/pi-web` at `b96b28b`. The inventory follows the fork's commit history and current source, rather than counting features that were later removed or adopted upstream.

### In-place file editing

Edit text files in the file viewer with a CodeMirror editor and save with `Ctrl/Cmd+S`. Atomic saves preserve permission bits and CRLF line endings. Revision checks reject stale saves; external changes refresh clean buffers but leave unsaved drafts intact with a conflict notice. Drafts survive tab switches, and closing a dirty tab asks for confirmation. Writes stay within the file API's allowed roots and refuse symlinks.

See [the file-editing design](./docs/adr/0006-file-editor-save-sync.md) and [File API](#file-api).

### Native questionnaires

Compatible `ask_user_question` extension dialogs render as browser forms instead of ANSI terminal panels. They support question tabs, option previews, multiple selections, custom answers, notes, review, submit, and cancel. Pending questionnaires can be replayed after a page refresh. Unsupported dialogs retain the existing custom-UI fallback.

For terminal-oriented extensions such as `@juicesharp/rpiv-ask-user-question`, set `PI_WEB_EXTENSION_MODE=tui` so the extension can request its full custom UI.

### Extension run-mode compatibility

`PI_WEB_EXTENSION_MODE` controls the mode advertised to extensions as `ctx.mode`: `rpc` (default), `tui`, `json`, or `print`. The fork also omits the unsupported raw-terminal `onTerminalInput` hook and converts percentage overlay widths into terminal columns for browser-rendered custom UI.

### Browser sudo password prompt

The bash tool can ask for a sudo password through a masked browser input. It passes the answer through a short-lived askpass helper, caches it per session wrapper for five minutes, and clears the cache after an authentication failure. Canceling or declining runs the command without a supplied password.

The helper keeps the password out of command text, arguments, and the child environment. It briefly stores the password in a permission-restricted file, readable by processes running as the same OS user until consumed or cleaned up. Detection is a command scan, not a shell parser: absolute-path sudo and indirect invocations are not covered. See [the sudo prompt design and limitations](./docs/adr/0007-sudo-password-prompt.md).

### Package-provided web panels

Installed Pi packages can declare right-panel UIs through `package.json#piWeb.panels`, without patching Pi Web. Panels have top-bar buttons, tabs, custom icons, workspace/session/theme context, and bridge messages for opening files, inserting composer text, and changing tab titles. Project-scoped panels require project trust; disabled packages are hidden.

Panels run with the same trust level as the installed package's Node extension, not as isolated untrusted web content. See [the panel contract](./docs/web-panels.md) and [runnable example](./examples/web-panel-plugin). The [Project Plan Manager](https://github.com/alfahluzi/project-plan-manager) panel uses this mechanism; it is a separate plugin, not a built-in feature.

### Move projects with their session history

The sidebar's **Move project…** action previews a move before a second confirmation. It relocates the folder, rewrites session paths and parent-session links, updates sidebar project state and trust records, and repairs Git worktree paths. Protection failures explain why a move was refused.

For folders moved outside Pi Web, `scripts/repair-session-paths.mjs` repairs the associated history and supports `--dry-run`. `scripts/move-pi-web.sh` handles moving the Pi Web checkout itself while the server is stopped. These tools change filesystem and session data; read [the operational notes](./LOCAL-CHANGES.md#moving-the-checkout-to-another-folder) before using them.

### System prompt editing and display

**Settings > System prompt** edits the agent directory's `SYSTEM.md` and `APPEND_SYSTEM.md`, with separate drafts, revision-guarded saves, project-override notices, and reset controls. Saving attempts to reload the open session so it picks up the change, and reports when the saved change could not be applied.

The system prompt viewer renders Markdown in labeled sections, including nested XML-style sections, with expand/collapse and raw-prompt copy controls. The earlier composer prompt-library picker was removed and is not part of this fork's current feature set.

### Collapsible JSON tool arguments

Tool cards can render nested JSON arguments as expandable objects and arrays when no specialized view owns the input. Large or deeply nested payloads fall back to text rather than rendering an unbounded tree.

### Running-tool timing hints

The running-tool status shows elapsed seconds against an explicit `timeout` argument. Bash commands containing literal `sleep` calls also show an estimated remaining sleep time. This is a heuristic that sums matching sleep durations as though they run sequentially, not a shell execution trace or completion guarantee.

### Fork-specific operations

- `PI_WEB_ALLOWED_HOSTS` also feeds Next.js development-origin allowances for tunnel and reverse-proxy hosts.
- `deploy-to-pi-web.sh` targets this maintainer's `pi-web-custom` PM2 setup. It is deployment-specific, not a general installation command.

Session pinning, archiving, side chats, MCP, and the standard sidebar are upstream features, not separate fork implementations. See [LOCAL-CHANGES.md](./LOCAL-CHANGES.md) for historical details; some version and deployment paths there describe earlier revisions.

## Upstream Features

- **Session workspace**: browse, resume, rename, export, and delete conversations grouped by project, with running state, context usage, cost, and compaction details.
- **Two ways to branch**: **New session** creates an independent session file from an earlier message; **Edit from here** creates a branch inside the current session.
- **Project file tools**: browse and upload files, inspect Git diffs, and preview source, Markdown, images, audio, PDFs, and DOCX files with automatic refresh.
- **Git worktrees**: switch checkouts from the sidebar while keeping sessions from the same repository grouped together.
- **Web-based configuration**: manage provider login and API keys, models, model tests, plugin packages, and skills without leaving Pi Web.
- **English, Simplified Chinese, and Traditional Chinese UI**: Pi Web follows the browser language initially and provides a language switcher in the top bar.

## Run This Fork

Use Node.js 22.19.0 or newer and clone this repository's `custom` branch:

```bash
git clone --branch custom https://github.com/alfahluzi/pi-web.git
cd pi-web
npm ci
npm run dev
```

Open [http://127.0.0.1:30141](http://127.0.0.1:30141). This starts the development server, not a production deployment. Do not run a build while the development server is running.

To enable terminal-oriented extensions' custom UI on macOS or Linux:

```bash
PI_WEB_EXTENSION_MODE=tui npm run dev
```

### Upstream npm Distribution

The npm package `@agegr/pi-web` and Docker image `ghcr.io/agegr/pi-web` belong to upstream. Installing them does **not** install this fork's custom features. The upstream commands below are retained for reference.

Pi Web requires Node.js 22.19.0 or newer. Check your version with `node --version`, then run:

```bash
npx @agegr/pi-web@latest
```

The CLI opens a browser after the server is ready. If it does not, open [http://127.0.0.1:30141](http://127.0.0.1:30141). Pi Web listens only on `127.0.0.1` by default.

If no model provider is configured yet, open the **Models** panel to sign in or add an API key.

To install the `pi-web` command globally:

```bash
npm install -g @agegr/pi-web@latest
pi-web
```

Commands:

```bash
pi-web version          # print the installed version
pi-web status           # list running servers
pi-web stop [--port N]  # stop a running server
pi-web open [--port N]  # open a running server in the browser
pi-web update [--check] # update a global npm install
```

To update, run `pi-web stop`, then `pi-web update` (or run the same install command again). To uninstall, run `npm uninstall -g @agegr/pi-web`.

## Configuration

For port and hostname, command-line options override the corresponding environment variables. Either `--no-open` or `PI_WEB_NO_OPEN=1` disables automatic browser opening. Run `pi-web --help` (or `-h`) to print startup options and exit without starting the server. Unknown options exit with an error.

| Option or environment variable | Purpose | Default |
| --- | --- | --- |
| `--help`, `-h` | Print startup options and exit | — |
| `--port <port>`, `-p <port>`, or `PORT` | Server port | `30141` |
| `--hostname <host>`, `-H <host>`, or `PI_WEB_HOSTNAME` | Bind hostname | `127.0.0.1` |
| `--no-open` or `PI_WEB_NO_OPEN=1` | Do not open a browser automatically | Browser opens |
| `PI_WEB_APP_NAME` | PWA manifest `name` and `short_name`; surrounding whitespace is trimmed, empty values use the default | `Pi Web` |
| `PI_WEB_SKIP_VERSION_CHECK=1` | Disable Pi Web update checks | Unset |
| `PI_WEB_ALLOWED_HOSTS` | Additional exact proxy or custom hostnames, comma-separated | Unset |
| `PI_WEB_PASSWORD` | Enable browser password login; API clients may use Basic Auth with username `pi` | Authentication disabled |
| `PI_WEB_IDLE_TIMEOUT_MS` | Session idle timeout in milliseconds, up to `2147483647`; `0` disables idle shutdown; invalid or out-of-range values use the default | `600000` (10 min) |
| `PI_WEB_SHUTDOWN_DEADLINE_MS` | How long extensions get to handle `session_shutdown` before a closing session is disposed anyway, in milliseconds up to `2147483647`; `0`, invalid or out-of-range values use the default | `5000` (5 s) |
| `PI_WEB_EXTENSION_MODE` | Fork-only: mode advertised to extensions as `ctx.mode`, one of `rpc`, `tui`, `json`, or `print`. Use `tui` for terminal-oriented extensions that gate custom UI on this mode. This does not provide raw terminal input. | `rpc` |
| `PI_CODEMODE_MAX_WORKERS` | pi worker limit for codemode scripts, shared across sessions and subagents. Pi Web sets `8` when unset or empty; each script may use up to 256 MB. | `8` |

Set `PI_WEB_APP_NAME` before starting the server (for example, `PI_WEB_APP_NAME='Work Pi' pi-web`). After changing it, restart the server to serve the new manifest; no rebuild is required. Updates to the name of an already installed PWA are managed by the browser and are not guaranteed to appear immediately. This does not change the page title or icons.

For example:

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### Remote Access

Binding to a non-loopback address exposes an agent that can execute high-privilege actions. On a trusted LAN, require a long random password:

```bash
PI_WEB_PASSWORD='a-long-random-password' pi-web --hostname 0.0.0.0
```

Password authentication does not encrypt the connection. Do not expose Pi Web over plain HTTP to the internet; use HTTPS through a trusted reverse proxy or a trusted VPN. If a reverse proxy sends an external hostname, add that exact name to `PI_WEB_ALLOWED_HOSTS`. This allow-list does not change the address Pi Web binds to.

### Docker

Each release publishes an image to `ghcr.io/agegr/pi-web`. See [Running Pi Web in Docker](./docs/docker.md) for it, the Compose example and which volumes to keep.

### HTTP Proxy

Server-side model and API requests honor the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables.

On macOS or Linux:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

On Windows PowerShell:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## Notes

- **Agent data**: Pi Web reads pi data from `~/.pi/agent` by default, including session files under `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Set `PI_CODING_AGENT_DIR` to use another pi agent directory.
- **Filesystem access**: Pi Web must be able to read the agent data directory and the working directories recorded by its sessions. Run Pi Web in the same filesystem environment as pi when sharing existing sessions.
- **Shared configuration**: the Models panel uses pi's model, settings, and credential storage, so changes are visible to both interfaces. An open session applies a saved edit of its model when you select the model again.
- **File access boundary**: the file browser is limited to working directories selected in Pi Web and project or session roots it already knows about; it is not a general filesystem browser.
- **Git worktrees**: see [Worktrees in Pi Web](./docs/worktrees.md) for switcher visibility, worktree creation, and removal behavior.

### File API

The viewer reads files through `GET /api/files/[...path]` (`type=list|read|watch|meta|preview|download`). Text reads also return a `revision` token, and the write endpoint uses it to detect conflicts:

| Request | Body | Response |
| --- | --- | --- |
| `PUT /api/files/[...path]` | `{ content, baseRevision }` | `{ revision, size, mtime }` |

A stale `baseRevision` is rejected with `409`, so the viewer can offer reload or overwrite instead of silently discarding a concurrent edit. Writes are atomic and preserve the file's permission bits.

### Downstream Session Context Menu

Electron wrappers and other downstream integrations can provide a session-row
context menu without patching `SessionSidebar`. Listen for the cancelable
`pi-web:session-row-contextmenu` browser event and call `preventDefault()`
synchronously when the integration will handle it:

```js
window.addEventListener("pi-web:session-row-contextmenu", (event) => {
  event.preventDefault();
  const { id, path, cwd, name, clientX, clientY, refresh } = event.detail;

  void openSessionMenu({ id, path, cwd, name, clientX, clientY }).then((changed) => {
    if (changed) refresh();
  });
});
```

The detail object contains `id`, `path`, `cwd`, optional `name`, pointer
coordinates, and a `refresh()` callback for actions that change the session
list. If no listener cancels the extension event, Pi Web opens its built-in
session menu (pin, rename, fork, mark read or unread, archive, open in new
tab, delete) at the pointer instead of the browser's native context menu.
The row's `⋯` button always opens the built-in menu and does not dispatch the
event. Sessions not yet saved to disk get no built-in menu, so the native one
still appears for them. This hook is browser-side and independent of Pi agent
extensions.

### Extension Session Liveness

Server-side Pi extensions with detached work can prevent automatic idle
session eviction through the versioned global registry:

```js
const liveness = globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")];
const release = liveness?.version === 1
  ? liveness.register({
      name: "my-extension",
      sessionId,
      sessionFile: sessionFile || undefined,
      isActive: () => detachedJobs.size > 0,
    })
  : () => {};
```

Register once per active extension session and call the returned idempotent
`release` function on session shutdown, replacement, or reload. `isActive`
must be synchronous, cheap, and scoped to the supplied exact session id or
file. Provider errors fail safe by preserving that session. This lease only
affects automatic idle eviction; explicit shutdown and Stop fallback cleanup
still take precedence.

## Development

```bash
npm install
npm run dev
```

The development server runs at [http://127.0.0.1:30141](http://127.0.0.1:30141). Run the common checks with:

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

Do not run `next build` or `npm run build` during normal development. It writes to `.next/` and can interfere with the development server; leave builds for release work.

Before starting on a feature, read [Contributing](./CONTRIBUTING.md) for what is in scope and the pull request checklist.

Contributor guides: [Internationalization](./docs/i18n.md) and [Release process](./docs/release.md).

## Repository Layout

```text
app/             Next.js UI and API routes
components/      React UI components
hooks/           Client state and interaction hooks
lib/             Session, agent, model, file, Git, and security logic
public/          Static assets and PWA files
bin/             npm CLI entrypoint and launch option parsing
docs/            Focused user and contributor guides
demo/            Static browser demo published to GitHub Pages (see demo/README.md)
```

See [AGENTS.md](./AGENTS.md) for the architecture notes and detailed file map.

## License

[MIT](./LICENSE)
