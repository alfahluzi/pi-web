# Local changes to pi-web

Last updated: 2026-10-23

This checkout is a fork of `@agegr/pi-web@0.12.2` (git tag `v0.12.2`). It carries
an opt-in patch so terminal-oriented Pi extensions can render their rich custom
UI in the browser, in-place file editing, a sudo password prompt for the bash
tool, and a generic web-panel mechanism so Pi packages can contribute right-panel
UIs without touching pi-web's source.

Upstream moved a long way since this fork started at `v0.9.3` (pi SDK
`0.87.1` → `1.2.0`, MCP support, a rewritten sidebar, subagent panels), so the
fork was rebased release by release; see "Rebase history" below for the tags and
what upstream took over.

## Fork & attribution

An unofficial fork of [`agegr/pi-web`](https://github.com/agegr/pi-web), which is
MIT licensed (`Copyright (c) 2026 agegr` — see `LICENSE`, kept unchanged). MIT
allows forking, modification, and redistribution provided the copyright notice
and license text stay in place. This fork lives at
[`alfahluzi/pi-web`](https://github.com/alfahluzi/pi-web).

- `origin` → `git@github.com:alfahluzi/pi-web.git` (this fork).
- `upstream` → `https://github.com/agegr/pi-web.git`.
- `custom` is the **deploy** branch: it is what `pm2 pi-web-custom` serves, and it
  is only moved once a rebase has been verified.
- `custom-next` is where a rebase is built and checked. It lives in a separate
  worktree (`../pi-web-upstream`) with its own `node_modules`, so a running
  pi-web session is never disturbed.
- `custom` carries the patches below, based on upstream tag `v0.12.2`.
- Upstream release tags are annotated, so resolve a commit with `v0.12.2^{}`.
- Verified hop tags: `fork-next-v0.10.0`, `fork-next-v0.11.1`,
  `fork-next-v0.12.2`; `fork-deploy-0.9.3` marks the last pre-rebase deploy.

## What changed

All changes are in `lib/rpc-manager.ts`, `lib/pi-types.ts`, `README.md`, and
`lib/rpc-manager.test.mjs`, plus the native questionnaire described below. See
`git diff`.

1. **`PI_WEB_EXTENSION_MODE` environment variable** — chooses the mode advertised
   to extensions as `ctx.mode` (`rpc` default, or `tui`/`json`/`print`).
   Pi Web renders extension custom components as ANSI text, so `tui` is the
   correct mode for hosts that can render custom UI. Some extensions
   (rpiv-ask-user-question among them) treat `ctx.mode === "rpc"` as
   "no custom UI here" and fall back to a degraded one-question-at-a-time
   dialog walker, so `rpc` would lose their full UI.
2. **`onTerminalInput` is now absent** instead of a no-op listener, so extensions
   correctly detect that Pi Web has no raw terminal input.
3. **Percentage overlay widths** (`"100%"`) now map to a real column count
   (~118 columns) so wide dialogs keep their intended geometry.

## In-place file editing with save-based sync

The file viewer can now edit text files in place instead of only previewing
them, and a save fans out to every open view.

- New files: `lib/file-edit.ts` (revision token and save-body validation),
  `lib/code-languages.ts` (lazy CodeMirror language loader; upstream's
  in-route extension map supplies the id), and
  `components/FileEditor.tsx` (the CodeMirror 6 editor). New tests accompany
  each.
- New endpoint: `PUT /api/files/[...path]` writes a file atomically while
  preserving its permission bits. It takes `{ content, baseRevision }`,
  answers `{ revision, size, mtime }`, and returns `409` when the file changed
  on disk underneath the editor. Text `read` responses now also return the
  `revision` token that a save passes back as `baseRevision`.
- Modified: `app/api/files/[...path]/route.ts` (write handler and revision in
  the read response), `lib/atomic-file.ts` (`writeFileAtomicSync`),
  `lib/file-viewer-state.ts` and `components/FileViewer.tsx` (`edit` display
  mode, save/reload/overwrite banner, draft in `FileViewerState.draft`, dirty
  guard on the watch refresh), `components/AppShell.tsx`,
  `components/TabBar.tsx`, and `components/file-tab-state.ts` (dirty tab dot
  and close prompt), plus the three `lib/i18n/messages/*` locale files.
- The SSE `change` handler refreshes a clean buffer but leaves a dirty one
  alone, showing a "file changed on disk" banner so a concurrent save cannot
  clobber unsaved edits.

## Enable the UI

`~/pi-web.env` sets:

```sh
PI_WEB_EXTENSION_MODE=tui
```

The rpiv extension is installed as a global Pi package:

```sh
pi install npm:@juicesharp/rpiv-ask-user-question
```

When the model calls `ask_user_question`, Pi Web now shows the full tabbed
questionnaire (options, previews, notes, multi-select, Submit review) in the
extension panel and routes keyboard input to it.

### Native questionnaire (no ANSI terminal)

The ANSI panel above is a terminal emulator: it renders the extension's TUI
overlay as text and feeds a hidden `<textarea>`'s keystrokes to it as escape
sequences. That works, but it is not a UI. `ask_user_question` now renders as a
real React form instead — tabs per question, side-by-side option previews,
multi-select checkboxes, per-question and global notes, the `Type something.`
row, and Cancel / Next / Review / Submit buttons.

How it works (all in `lib/rpc-manager.ts`, `lib/questionnaire.ts`,
`components/QuestionnairePanel.tsx`):

- `tool_execution_start` for `ask_user_question` carries the full tool
  arguments, which is the only place the option `preview` bodies exist (the
  extension's public `rpiv:ask-user:prompt` event ships `hasPreview` only). The
  wrapper parses them and remembers the call.
- When the extension calls `ctx.ui.custom()` for that call, the wrapper skips
  the component factory entirely and emits a `custom` request carrying the
  questions. The browser renders `QuestionnairePanel`; submitting posts
  `extension_ui_questionnaire` with a `QuestionnaireResult` that the wrapper
  re-validates and resolves into the extension's `ui.custom()` promise.
- The extension still owns validation, the sentinel rows, and the LLM-facing
  envelope, so the model sees exactly what the TUI would have produced
  (`User has answered your questions: "Q"="A". …`).
- Anything that is not a renderable questionnaire (malformed args, a stale
  call, another extension's dialog) falls back to the existing ANSI panel.
- The pending request is registered in `pendingUiRequests`, so a page refresh or
  a second tab is replayed the questionnaire instead of a stuck transcript.

`PI_WEB_EXTENSION_MODE=tui` is still required: the extension only reaches
`ui.custom()` in non-`rpc` modes, and `rpc` would route it to its own degraded
one-dialog-per-question walker before Pi Web ever sees it.

## Project Plan panel moved out to a plugin

The native React `.ppm` panel that used to live in this fork
(`lib/ppm/*`, `app/api/ppm/route.ts`, `components/ProjectPlanPanel.tsx`) has been
**removed**. It now ships as a pi-web web panel in the
[`project-plan-manager`](https://github.com/alfahluzi/project-plan-manager) repo
(`panel/` + a `package.json#piWeb` declaration), so this fork carries no
plan-specific code and the panel is versioned with the skill that owns it.

What that means:

- `lib/ppm/`, `app/api/ppm/`, `components/ProjectPlanPanel.tsx`,
  `components/project-plan-model.ts`, `components/project-plan-tab-state.ts` and
  their tests are gone, along with the `plan` tab kind in `TabBar.tsx` and the
  `plan.*` i18n keys in `lib/i18n/messages/*`.
- The panel reuses the original `templates/task.html` design and reads `.ppm`
  through pi-web's generic file API (`/api/files?type=list|read`), rebuilding the
  same `/api/tasks` payload in the browser. Execute/Audit insert into the chat
  composer and Open plan.md opens the FileViewer via the web-panel bridge.
- Install it with `pi install npm:project-plan-manager-agent-skill` (or a local
  path / git source); no pi-web change is needed to add or update it.
- The registered-project dropdown from the old panel is gone: the config file it
  read lives outside pi-web's allowed roots, so the plugin shows the active
  workspace only. See `docs/web-panels.md` for the plugin contract.

## Web panels (plugin-contributed right panels)

A Pi package can now add a top-bar button and its own right-panel UI without any
change to pi-web's source. The mechanism, the `package.json#piWeb` manifest, the
context/message bridge, and the trust model are documented in
[`docs/web-panels.md`](docs/web-panels.md); a runnable example lives in
[`examples/web-panel-plugin`](examples/web-panel-plugin).

New files:

- `lib/web-panel-manifest.ts` — pure manifest parsing, icon names, and the
  package-root containment rules (unit tested in isolation).
- `lib/web-panels.ts` — SDK-backed registry: scans installed Pi packages, honours
  disable/project-trust, and keeps an id→declaration map for asset requests.
- `lib/web-panel-bridge.ts` — workspace-relative path resolution for
  `pi-web:open-file`.
- `app/api/web-panels/route.ts` — `GET ?cwd=` list of panels.
- `app/api/web-panels/[id]/[[...path]]/route.ts` — serves the panel document and
  its relative assets from the owning package (MIME-typed, `no-store`, symlink
  checked).
- `components/WebPanelFrame.tsx`, `components/WebPanelIcon.tsx`,
  `components/web-panel-tab-state.ts`.

Modified: `components/AppShell.tsx` (fetch + top-bar buttons + `plugin` tabs +
iframe rendering) and `components/TabBar.tsx` (new `plugin` tab kind).

A panel is an iframe, not a React component, because Pi extensions run in Node
and cannot render into the browser. The panel is trusted at the same level as the
package's extension code; assets are live-read so a plugin can be edited while
`npm run dev` runs.

## Session pins: dropped in favour of upstream

This fork used to add its own pinned-sessions sidecar. Upstream v0.11.0 shipped
session pinning (plus per-project order and archiving) in
`app/api/sessions/ui-state` and `lib/session-ui-state.ts`, so the rebase deleted
the fork's `lib/session-pins.ts`, `lib/session-pin-order.ts`,
`lib/session-list-rows.ts`, `app/api/sessions/pinned/`, and the sidebar patch.
Pinning works through the upstream sidebar now.

## Sudo password prompts in the bash tool

Pi runs tool commands without a terminal, so `sudo` cannot prompt. When a command
invokes `sudo`, the wrapper asks the operator in the browser (a secret input on
the existing extension-UI channel) and hands the answer to an askpass helper, so
the password never appears in the command text, argv, the child environment, the
tool result, the transcript or a log. Declining, cancelling or timing out simply
runs the command without a password, exactly as before the feature.

- New files: `lib/sudo-prompt.ts` (askpass helper files, `mkdtemp` lifecycle, the
  per-wrapper password cache and its TTL), `docs/adr/0007-sudo-password-prompt.md`.
- Modified: `lib/project-command-env.ts` (the `sudo()` shell prefix with
  `command sudo -A`, failure detection), `lib/rpc-manager.ts`
  (`requestSudoPassword`, `extension_ui_input` handling), `lib/pi-types.ts`
  (`SecretInputRequest`), and the i18n `chat.extensionSecretNote` key.
- sudo-rs (Ubuntu 26.04) ignores `SUDO_ASKPASS` without `-A`; the prefix passes
  it. `/usr/bin/sudo`, `xargs sudo`, `sh -c 'sudo …'` and `eval` are not covered,
  because `commandNeedsSudo()` is a scan and not a parser.

## Rebase history

Upstream releases were replayed in order, one hop per tag, with `tsc --noEmit`,
`npm test` and `npm run lint` green before the next hop started:

| Hop | Base tag | pi SDK | Notes |
| --- | --- | --- | --- |
| 1 | `v0.10.0` | 0.87.1 → 1.0.0 | Extension custom UI became a queue; the questionnaire clears its id from it. |
| 2 | `v0.11.0` → `v0.11.1` | 1.1.0 | Sidebar rewritten (`SessionTree`/`SidebarMenu`) and upstream gained session pins, so the fork's pin sidecar was deleted. `plugin` tabs learned to coexist with `agent` tabs. |
| 3 | `v0.12.0` → `v0.12.1` → `v0.12.2` | 1.1.0 → 1.2.0 | Upstream's right-panel layout and subagent viewer adopted; upstream's in-route language map replaced `lib/file-language.ts`; MCP/codemode came along. |

Three commits on top of the replay are fixes the rebase itself needed: the
questionnaire queue fix, the pin-sidecar removal, and the plugin-tab panel state.

**What upstream took over, and what the fork therefore dropped:**

- Session pins → `app/api/sessions/ui-state` + `lib/session-ui-state.ts`
  (also per-project order and archiving).
- File language ids → the map inside `app/api/files/[...path]/route.ts`;
  `lib/code-languages.ts` still feeds CodeMirror and now accepts `tsx`, `jsx`
  and `markup`.
- File tree visibility, worktrees, MCP, subagent panels, the sidebar: pure
  upstream now, no fork patches.

**What the fork still owns:** `PI_WEB_EXTENSION_MODE` and the absent
`onTerminalInput`, percentage overlay widths, `PUT /api/files` editing, the
native questionnaire panel, the sudo prompt, and the web-panel mechanism.

## Deploy

`./deploy-to-pi-web.sh` promotes this build to the globally installed `pi-web`
command used by pm2 (app `pi-web-custom`, port 4201), by symlinking
`~/.local/lib/node_modules/@agegr/pi-web` to this directory. This git repository
is the single source of truth: the original npm install, its
`@agegr/pi-web.npm-backup` copy, and the former `pi-web` app on port 4200 were
all removed on 2026-10-01. Revert instructions are at the top of the script.

### Moving the checkout to another folder

`./scripts/move-pi-web.sh <new-path>` moves this checkout, with the history of
the sessions that ran in it, and puts pi-web back in service from the new path.
The sidebar's "Move project…" refuses this folder on purpose (it is where pi-web
runs from), so the script does it with the server stopped: it deletes the PM2
app, runs `lib/project-move.ts` through `scripts/move-pi-web.mjs` (the same code
path as the sidebar's move, plus `allowServerCwd`), rebuilds (`.next` holds
absolute paths), then hands over to `./deploy-to-pi-web.sh`, which repoints
`~/.local/lib/node_modules/@agegr/pi-web` and starts the app. Any failure after
the move rolls back — folder and sessions both — and restarts the old path.

`--dry-run` validates and prints the plan without stopping anything. The
destination must keep the folder's name, must not exist, and must be on the same
filesystem; a dirty checkout is refused unless `--force`.

### Promoting a verified `custom-next` to `custom`

Restarting pi-web ends any running agent session (including the one you are
typing in), so do this when the chat is idle.

1. `git -C /home/ljosalfar-server/Documents/pi-web status` is clean and says
   `## custom`.
2. `git -C /home/ljosalfar-server/Documents/pi-web merge --ff-only custom-next`
   — the rebase branch already sits on upstream `v0.12.2`, so this is the whole
   merge.
3. `cd /home/ljosalfar-server/Documents/pi-web && npm install` (pi 1.2.0 plus the
   fork's codemirror packages), then `npm run build` (never during `npm run dev`).
4. `pm2 restart pi-web-custom` (or `./deploy-to-pi-web.sh`, which also restarts
   and saves the process list).
5. Rollback: `git reset --hard fork-deploy-0.9.3 && npm install && npm run build
   && pm2 restart pi-web-custom`, or check out the hop tag you last trusted.

Keep the worktree (`../pi-web-upstream`) as the place for the next rebase; it can
be removed with `git worktree remove ../pi-web-upstream` once `custom-next` lives
in the main checkout.
