#!/usr/bin/env bash
#
# Move this pi-web checkout — and the history of the sessions that ran in it —
# to another folder.
#
# The sidebar's "Move project…" refuses this one folder on purpose: it is the
# folder pi-web itself runs from, so renaming it leaves the process's cwd, the
# PM2 app's exec path, the global `@agegr/pi-web` symlink and the absolute paths
# baked into `.next` dangling mid-request. This script does the same move with
# the server stopped, which is the only moment it is safe:
#
#   1. Preflight: the destination must not exist, must keep the folder's name,
#      must be on the same filesystem, and the checkout must be clean unless
#      --force (the move carries whatever is in the folder).
#   2. Delete the PM2 app, so nothing holds the folder.
#   3. Move the folder and re-file every session under the new cwd, re-key the
#      sidebar state and trust.json (lib/project-move.ts via
#      scripts/move-pi-web.mjs — the same code path as the sidebar's move,
#      with the server-stopped escape hatch).
#   4. Rebuild: `.next` carries absolute paths from the old location.
#   5. ./deploy-to-pi-web.sh: repoint the global symlink, start the app, save
#      the process list.
#
# Any failure after step 3 rolls back: the folder moves back, its sessions
# follow, and the app is started again from where it was.
#
# Usage:
#   scripts/move-pi-web.sh <new-path> [--dry-run] [--yes] [--force] [--no-build]
#
#   <new-path>   the checkout's new full path, e.g. ~/Projects/pi-web
#                (the last component must stay "$(basename <this checkout>)")
#   --dry-run    validate and print the plan; change nothing, stop nothing
#   --yes        do not ask for confirmation
#   --force      move even with uncommitted changes
#   --no-build   skip `npm run build` (only safe if you rebuild yourself)
#
# Environment: PI_WEB_APP (PM2 app name, default pi-web-custom).
#
# Restarting pi-web ends any running agent session, including the one you may be
# typing in: run this from a terminal that is not pi-web, when the chat is idle.
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve this checkout first, then re-exec from a copy: the script is about to
# move the directory it is being read from, and bash reads a script as it runs.
# ---------------------------------------------------------------------------
REPO="${PI_WEB_MOVE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
if [ -z "${PI_WEB_MOVE_COPY:-}" ]; then
  COPY="$(mktemp "${TMPDIR:-/tmp}/move-pi-web.XXXXXX.sh")"
  cp "${BASH_SOURCE[0]}" "$COPY"
  chmod +x "$COPY"
  PI_WEB_MOVE_COPY=1 PI_WEB_MOVE_REPO="$REPO" exec bash "$COPY" "$@"
fi

APP="${PI_WEB_APP:-pi-web-custom}"
ECOSYSTEM="$HOME/pi-web.ecosystem.config.js"
DEPLOY="$REPO/deploy-to-pi-web.sh"
HELPER="$REPO/scripts/move-pi-web.mjs"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

# PM2 and node may only be on an nvm PATH, which a cron-less shell may lack.
pm2_bin() {
  if command -v pm2 >/dev/null 2>&1; then command -v pm2; return; fi
  local candidate
  for candidate in "$HOME"/.nvm/versions/node/*/bin/pm2; do
    [ -x "$candidate" ] && { printf '%s' "$candidate"; return; }
  done
  fail "pm2 not found in PATH or ~/.nvm"
}
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || fail "node not found in PATH"
PM2="$(pm2_bin)"

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
NEW_ARG=""
DRY_RUN=0
ASSUME_YES=0
FORCE=0
BUILD=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    --force) FORCE=1 ;;
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '1,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) fail "unknown option: $arg" ;;
    *) [ -z "$NEW_ARG" ] || fail "only one destination path is taken"; NEW_ARG="$arg" ;;
  esac
done
[ -n "$NEW_ARG" ] || fail "usage: scripts/move-pi-web.sh <new-path> [--dry-run] [--yes] [--force] [--no-build]"

# ~ and relative paths are the user's, not the shell's: expand against $HOME.
case "$NEW_ARG" in
  "~") NEW="$HOME" ;;
  "~/"*) NEW="$HOME/${NEW_ARG#\~/}" ;;
  /*) NEW="$NEW_ARG" ;;
  *) fail "give an absolute path, or one starting with ~/" ;;
esac
NEW="$(printf '%s' "$NEW" | sed 's:/*$::')"   # mv is the creator: no trailing slash
REAL_REPO="$(cd "$REPO" && pwd -P)"
[ "$(basename "$NEW")" = "$(basename "$REAL_REPO")" ] \
  || fail "the folder's name must stay \"$(basename "$REAL_REPO")\": $NEW
       move the checkout to e.g. $(dirname "$NEW")/$(basename "$REAL_REPO")"

[ -e "$NEW" ] && fail "destination already exists: $NEW"
[ -f "$ECOSYSTEM" ] || fail "ecosystem file not found: $ECOSYSTEM"
[ -f "$DEPLOY" ] || fail "deploy script not found: $DEPLOY"
[ -f "$HELPER" ] || fail "helper not found: $HELPER"

case "$NEW" in
  "$REAL_REPO"|"$REAL_REPO"/*) fail "the destination is inside the checkout: $NEW" ;;
esac
case "$REAL_REPO" in
  "$NEW"/*) fail "the destination contains the checkout: $NEW" ;;
esac

# Same filesystem: `mv` would otherwise copy gigabytes of node_modules and
# .next, and the sessions' new paths would sit on a device the server may not
# see after a reboot.
PARENT="$(dirname "$NEW")"
existing_parent="$PARENT"
while [ ! -d "$existing_parent" ]; do existing_parent="$(dirname "$existing_parent")"; done
[ "$(stat -c %d "$REAL_REPO")" = "$(stat -c %d "$existing_parent")" ] \
  || fail "the destination is on another filesystem: $NEW (nearest existing: $existing_parent)"

if [ "$FORCE" -eq 0 ]; then
  changed="$(git -C "$REAL_REPO" status --porcelain | head -5)"
  [ -z "$changed" ] || fail "the checkout has uncommitted changes; commit them, or pass --force:
$changed"
fi

# The app must be the one serving this checkout, or the "stop" below would stop
# something else and leave pi-web holding the folder.
"$PM2" jlist >/dev/null 2>&1 || fail "pm2 is not answering; start it with: pm2 resurrect"
APP_JSON="$("$PM2" jlist | "$NODE_BIN" -e '
  const apps = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const name = process.argv[1];
  const app = apps.find((entry) => entry.name === name);
  if (!app) { console.log(JSON.stringify({ missing: true })); process.exit(0); }
  console.log(JSON.stringify({
    cwd: app.pm2_env.pm_cwd,
    exec: app.pm2_env.pm_exec_path,
    args: app.pm2_env.args,
  }));
' "$APP")"
"$NODE_BIN" -e 'process.exit(JSON.parse(process.argv[1]).missing ? 0 : 1)' "$APP_JSON" \
  || fail "no PM2 app named $APP (set PI_WEB_APP to the right name)"
APP_CWD="$("$NODE_BIN" -e 'console.log(JSON.parse(process.argv[1]).cwd || "")' "$APP_JSON")"
[ "$(cd "$APP_CWD" 2>/dev/null && pwd -P || printf '%s' "$APP_CWD")" = "$REAL_REPO" ] \
  || fail "PM2 app $APP runs from $APP_CWD, not this checkout ($REAL_REPO)"

# A dev server in this checkout would also hold the folder (and would be
# serving an unbuilt tree: this script rebuilds, which AGENTS.md forbids then).
if pgrep -f "next dev" >/dev/null 2>&1 && pgrep -af "next dev" | grep -Fq "$REAL_REPO"; then
  fail "a dev server is running from this checkout; stop 'npm run dev' first"
fi

PLAN="$("$NODE_BIN" "$HELPER" --plan-only --root "$REAL_REPO" --new-path "$NEW")" \
  || fail "the move cannot be planned: $PLAN"

# Node prints how the plan reads; the shell prints what it will do about it.
PLAN_SUMMARY="$("$NODE_BIN" -e '
  const plan = JSON.parse(process.argv[1]);
  const sessions = plan.sessionCount;
  console.log(`${sessions} session file(s), ${plan.worktrees} worktree path(s)`);
' "$PLAN")"

step "Plan"
say "  from:        $REAL_REPO"
say "  to:          $NEW"
say "  carries:     $PLAN_SUMMARY"
say "  PM2 app:     $APP (stopped and recreated from $ECOSYSTEM)"
say "  global link: $(npm root -g 2>/dev/null || printf '%s' "$HOME/.local/lib/node_modules")/@agegr/pi-web -> $NEW"
[ "$BUILD" -eq 1 ] && say "  rebuild:     npm run build (needed: .next holds absolute paths)"
say
say "This ends any running pi-web session, including a chat you are typing in."

if [ "$DRY_RUN" -eq 1 ]; then
  step "Dry run: nothing was stopped, moved or built"
  exit 0
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  printf '\nType "move" to continue: '
  read -r answer
  [ "$answer" = "move" ] || fail "aborted"
fi

# ---------------------------------------------------------------------------
# Move: stop, relocate, rebuild, deploy. Rolls back on any failure after the
# relocation.
# ---------------------------------------------------------------------------
MOVED=0
STOPPED=0
UNDOING=0

# The sessions follow the folder back, so a rollback does not leave the sidebar
# with two projects: the move code path is symmetric.
rollback() {
  [ "$UNDOING" -eq 1 ] && return 1
  UNDOING=1
  set +e
  step "Rolling back"
  "$PM2" delete "$APP" >/dev/null 2>&1
  if "$NODE_BIN" "$NEW/scripts/move-pi-web.mjs" --root "$NEW" --new-path "$REAL_REPO" \
    && ( cd / && bash "$REAL_REPO/deploy-to-pi-web.sh" ); then
    say "Rolled back to $REAL_REPO"
    set -e
    return 0
  fi
  say "Rollback failed. The checkout is at $NEW; its sessions may point at either path."
  set -e
  return 1
}

on_error() {
  status=$?
  # 130/143: Ctrl-C or a TERM. Both deserve the same care as an error.
  if [ "$MOVED" -eq 1 ]; then
    rollback || true
  elif [ "$STOPPED" -eq 1 ]; then
    say "Nothing was moved; starting $APP again"
    ( cd "$REAL_REPO" && bash "$DEPLOY" ) || say "Could not restart $APP; start it with: pm2 start $ECOSYSTEM --only $APP"
  fi
  exit "$status"
}
trap on_error ERR INT TERM

step "Stopping $APP"
"$PM2" delete "$APP" >/dev/null
STOPPED=1

step "Moving the checkout (and its sessions)"
mkdir -p "$PARENT"
( cd / && "$NODE_BIN" "$HELPER" --root "$REAL_REPO" --new-path "$NEW" )
MOVED=1
cd /

step "Rebuilding in $NEW"
if [ "$BUILD" -eq 1 ]; then
  ( cd "$NEW" && npm run build )
else
  say "skipped (--no-build)"
fi

step "Deploying from $NEW"
bash "$NEW/deploy-to-pi-web.sh"

# ---------------------------------------------------------------------------
# Health: the launcher answers /login once next is serving.
# ---------------------------------------------------------------------------
PORT="$("$NODE_BIN" -e '
  const config = require(process.env.HOME + "/pi-web.ecosystem.config.js");
  const args = config.apps[0]?.args ?? "";
  const port = /--port\s+(\d+)/.exec(args);
  console.log(port ? port[1] : "30141");
')"
step "Waiting for http://127.0.0.1:$PORT/login"
status=""
for _ in $(seq 1 60); do
  status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login" --max-time 2 || true)"
  case "$status" in 2*|3*) break ;; esac
  sleep 1
done
if [ "$status" = "000" ] || [ -z "$status" ]; then
  say "pi-web did not answer within 60s; see: pm2 logs $APP --lines 50"
  rollback
  exit 1
fi

MOVED=0
STOPPED=0
trap - ERR INT TERM
step "Done"
say "  checkout: $NEW"
say "  serving:  http://127.0.0.1:$PORT  (status $status)"
"$PM2" list | grep -F "$APP" || true
say
say "Undo: scripts/move-pi-web.sh $REAL_REPO --yes   (from the new checkout)"
say "Logs: pm2 logs $APP --lines 50"
