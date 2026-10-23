# Upstream 0.12 Rebase

Created: 2026-10-23
Last updated: 2026-10-23

## 1. Objective

Replay the eight fork commits of `alfahluzi/pi-web` (branch `custom`, based on
upstream tag `v0.9.3`) onto upstream releases in order — `v0.10.0`, `v0.11.0`,
`v0.11.1`, `v0.12.0`, `v0.12.1`, `v0.12.2` — on a **new branch `custom-next`**
inside an isolated worktree, leaving the deployable branch `custom` untouched.
Each hop must end with the fork features intact, `tsc --noEmit` clean against the
hop's pi SDK, and a tag recording the hop.

## 2. Source documents and requirements

- Upstream releases: `git tag --contains 0876cf4` → v0.9.3 … v0.12.2 (dates in `git log`).
- `LOCAL-CHANGES.md` — inventory of fork patches (extension mode, terminal input,
  overlay widths, file editing, session pins, web panels, PPM panel, sudo prompt).
- `AGENTS.md` — fork-specific architecture notes that must survive the rebase.
- `deploy-to-pi-web.sh` — how `custom` is promoted to `pm2 pi-web-custom`.
- `.ppm/upstream-0.12-rebase/` — this plan.
- Fork branch: `git log --oneline custom ^upstream/HEAD` → 8 commits, 76 files.

## 3. Current-state findings

- `custom` = `7092dba`, version `0.9.3`, pi SDK `0.87.1`, Next `16.3.6`.
- Upstream `upstream/HEAD` = `e533d9b` (2026-10-20), version `0.12.2`.
- Divergence: **317 upstream commits** not present, **8 fork commits** local.
- Upstream diff since the merge base: 869 files, +159 610 / −11 744.
- pi SDK path: `0.87.1` → `v0.10.0: 1.0.0` → `v0.11.0: 1.1.0` → `v0.12.1: 1.2.0`;
  Next `16.3.6` → `16.3.8` at v0.11.0. New SDK packages: `pi-mcp`, `pi-codemode`,
  `pi-telemetry`.
- Conflict surface measured with `git merge-tree --write-tree` between `custom`
  and each tag: v0.10.0 = 13 files, v0.11.0 = 14, v0.12.0 = 18, v0.12.2 = 19.
  Recurring hotspots: `lib/rpc-manager.ts`, `components/SessionSidebar.tsx`,
  `components/AppShell.tsx`, `components/ChatWindow.tsx`,
  `app/api/files/[...path]/route.ts`, `hooks/useAgentSession.ts`,
  `lib/api-types.ts`, `lib/i18n/messages/*.ts`, `package.json`, `package-lock.json`,
  `AGENTS.md`, `README.md`.
- Upstream did **not** adopt the fork features: no `PUT` file save, no session
  pins (`lib/session-pins.ts` absent; upstream "pins" are *project* pins), no
  `PI_WEB_EXTENSION_MODE`, `onTerminalInput: () => () => {}` still present.
- The live `pm2 pi-web-custom` app (port 4201) runs **from the main checkout**
  and is serving the current agent session: its parent is `next-server` PID
  13992. Any `npm install`, `next build`, or branch switch in
  `/home/ljosalfar-server/Documents/pi-web` would break or restart it.

## 4. Constraints and invariants

- **`custom` stays deploy-ready.** No commits, no installs, no rebuilds in the
  main checkout. All work happens in `/home/ljosalfar-server/Documents/pi-web-upstream`
  (`custom-next`), which has its own `node_modules`.
- Safety tag `fork-deploy-0.9.3` marks the current deployable commit.
- Fork behaviour must remain: `PI_WEB_EXTENSION_MODE`, absent `onTerminalInput`,
  percentage overlay widths, `PUT /api/files/[...path]` with revision guard,
  session pins sidecar, package web panels, PPM panel, sudo askpass prompt,
  native questionnaire.
- Upstream behaviour must be adopted wholesale where the fork has no opinion
  (MCP, terminal, sidebar groups, subagent panels, i18n) — resolve conflicts by
  taking upstream and re-applying only the fork's distinct behaviour.
- MIT attribution in `LICENSE` and `LOCAL-CHANGES.md` stays intact.
- No `next dev --webpack` fallback; no `next build` during dev experimentation.

## 5. Proposed approach

1. Freeze `custom` (tag `fork-deploy-0.9.3`), create worktree
   `/home/ljosalfar-server/Documents/pi-web-upstream` on new branch `custom-next`.
2. `npm install` in the worktree and record a green baseline (`tsc --noEmit`).
3. For each upstream tag in ascending order run
   `git rebase --onto <tag> <previous-tag-or-merge-base>` replaying the eight fork
   commits, resolving conflicts with "upstream wins for upstream-only concerns,
   fork keeps its distinct behaviour", then `npm install` and `tsc --noEmit`
   until clean. Tag the result `fork-next-<version>`.
4. Hops are grouped into release phases because each hop's result must be
   verified before the next rebase can start (rebase has a single index — the
   work is inherently serial, which is why every phase has one worker task plus
   one verification task).

## 6. Dependencies

- Network access for `npm install` per hop (registry + `bin/prepare-terminal.js`).
- Node 24 via nvm (already active), no Rust/Go/Java needed.
- Upstream tags already fetched locally (`git fetch upstream --tags` done).

## 7. Risks and mitigations

- **Killing the live session**: work only in the separate worktree; never restart
  or reinstall in the main checkout.
- **SDK 1.x API drift breaks the fork patches**: typecheck each hop; if a fork
  patch (extension mode, sudo askpass, exact prompt) no longer matches the SDK,
  fix it at that hop instead of deferring to the end.
- **Sidebar rewrite loses session pins**: upstream rewrote `SessionSidebar.tsx`
  (now split into `SessionTree.tsx`, `SidebarMenu.tsx`, `session-catalog-helpers.ts`).
  Re-apply the pin row model (`lib/session-list-rows.ts`) against the new tree
  rather than resurrecting the old file.
- **Web panels vs upstream panel layout**: upstream added `lib/panel-layout.ts`
  and `SubagentViewer.tsx` for right-panel tabs. Reconcile the plugin tab kind
  with the new panel host instead of keeping a competing layout.
- **Lockfile churn**: resolve `package-lock.json` by regenerating once per hop
  (`npm install` after accepting upstream `package.json` + fork's added deps).
- **Silent behaviour loss**: verify the fork checklist manually on the final hop
  (extension mode env, file save, pins, panels, PPM, sudo prompt).

## 8. Verification strategy

- Per hop: `node_modules/.bin/tsc --noEmit` clean in the worktree.
- Per hop: `npm test` (unit suites) green; `npm run lint` clean for touched files.
- Final hop: `npm run dev` on port 30142 in the worktree, smoke the fork features
  and the new upstream features, then stop the dev server.
- Final hop: `git log --oneline upstream/HEAD..custom-next` shows only the fork's
  own commits; `git diff --stat` against `v0.12.2` shows only fork deltas.

## 9. Definition of done

- Branch `custom-next` exists in the worktree, rebased onto `v0.12.2`, with the
  eight fork features working and `tsc --noEmit`, `npm test`, `npm run lint` green.
- Tags `fork-next-v0.10.0` … `fork-next-v0.12.2` mark the verified hops.
- `LOCAL-CHANGES.md` and `AGENTS.md` updated to describe the rebased fork.
- The main checkout `custom` branch is still at `7092dba` (deploy untouched) and
  the running `pi-web-custom` app was never interrupted.
- Deploy decision (promote `custom-next` → `custom` and redeploy) is left to the
  user, with a runbook written down.
