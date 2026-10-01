# Local changes to pi-web

This checkout is a fork of `@agegr/pi-web@0.9.3` (git tag `v0.9.3`) with a small,
opt-in patch so terminal-oriented Pi extensions can render their rich custom UI
in the browser. It exists to support
[`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question).

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
`lib/rpc-manager.test.mjs`. See `git diff`.

1. **`PI_WEB_EXTENSION_MODE` environment variable** — chooses the mode advertised
   to extensions as `ctx.mode` (`rpc` default, or `tui`/`json`/`print`).
   Pi Web renders extension custom components as ANSI text, so `tui` is the
   correct mode for hosts that can render custom UI. Some extensions
   (rpiv-ask-user-question among them) gate their full terminal UI on
   `ctx.mode === "rpc"` and otherwise fall back to a degraded one-question-at-a-time
   dialog walker.
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

## Project Plan panel (`.ppm`)

A native React panel that renders
[`project-plan-manager`](https://github.com/alfahluzi/project-plan-manager) plans
(`.ppm/<plan>/plan.md` + `tasks/phase_*.json`) in Pi Web's right panel, replacing
the standalone `templates/task.html` dashboard.

New files:

- `lib/ppm/{patterns,types,analysis,validate,reader}.ts` — faithful port of the
  CLI's phase validation + plan analysis (waves, critical path, file-conflict
  lint, legacy `start`/`fail_desc` normalization).
- `app/api/ppm/route.ts` — `GET /api/ppm?cwd=<abs>&scope=workspace|registered`,
  read-only; validated against the same allowed file roots as the other routes.
  `PI_WEB_PPM_CONFIG` overrides the config path (used by tests).
- `components/ProjectPlanPanel.tsx`, `components/project-plan-model.ts`,
  `components/project-plan-tab-state.ts`.

Modified: `components/AppShell.tsx` and `components/TabBar.tsx` (new `plan` tab
kind + top-bar toggle), `lib/i18n/messages/{en,zh-CN,zh-TW}.ts` (`plan.*` keys).

Behaviour:

- A **Project plan** icon in the top bar opens a `plan:<cwd>` tab in the right
  panel (desktop; on mobile it is shown when the toolbar is not narrow).
- Data is read server-side from disk and polled every 5s while the tab is
  visible and the panel is open. Phases/tasks match the CLI's verdicts, so the
  UI never looks healthier than `ppm plan_validate`.
- **Execute/Audit** buttons insert the same prompt strings as `task.html` into
  the chat composer (`Execute Plan`, `Audit Plan`, `Execute Phase`,
  `Audit Phase`); **Open plan.md** opens the file in the existing FileViewer.
- Read-only: the panel never writes `.ppm` files.

Not implemented (possible follow-ups): auto-opening the panel when a workspace
contains `.ppm`, and editing task status from the panel.

## Deploy

`./deploy-to-pi-web.sh` promotes this build to the globally installed `pi-web`
command used by pm2, by symlinking `~/.local/lib/node_modules/@agegr/pi-web` to
this directory. This git repository is the single source of truth: the original
npm install and its `@agegr/pi-web.npm-backup` copy were removed on 2026-10-01.
Revert instructions are at the top of the script.

Restarting pi-web ends any running agent session, so run it when you are not in
the middle of a conversation.
