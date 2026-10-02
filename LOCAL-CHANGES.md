# Local changes to pi-web

This checkout is a fork of `@agegr/pi-web@0.9.3` (git tag `v0.9.3`). It carries
an opt-in patch so terminal-oriented Pi extensions can render their rich custom
UI in the browser, plus a generic web-panel mechanism so Pi packages can
contribute right-panel UIs without touching pi-web's source.

## Fork & attribution

An unofficial fork of [`agegr/pi-web`](https://github.com/agegr/pi-web), which is
MIT licensed (`Copyright (c) 2026 agegr` — see `LICENSE`, kept unchanged). MIT
allows forking, modification, and redistribution provided the copyright notice
and license text stay in place. This fork lives at
[`alfahluzi/pi-web`](https://github.com/alfahluzi/pi-web).

- `origin` → `git@github.com:alfahluzi/pi-web.git` (this fork, `custom` branch).
- `upstream` → `https://github.com/agegr/pi-web.git`.
- `main` mirrors upstream releases: `git fetch upstream && git rebase upstream/main`.
- `custom` carries the patches below, based on upstream tag `v0.9.3`.
- Upstream release tags are annotated, so resolve a commit with `v0.9.3^{}`.

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

## Deploy

`./deploy-to-pi-web.sh` promotes this build to the globally installed `pi-web`
command used by pm2 (app `pi-web-custom`, port 4201), by symlinking
`~/.local/lib/node_modules/@agegr/pi-web` to this directory. This git repository
is the single source of truth: the original npm install, its
`@agegr/pi-web.npm-backup` copy, and the former `pi-web` app on port 4200 were
all removed on 2026-10-01. Revert instructions are at the top of the script.

Restarting pi-web ends any running agent session, so run it when you are not in
the middle of a conversation.
