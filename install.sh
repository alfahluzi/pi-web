#!/bin/sh
#
# Install this pi-web fork as the global `pi-web` command: update the checkout,
# install its dependencies, build .next, and link the checkout into npm's
# global prefix.
#
# With no checkout to install, it clones the fork first, so this works on a
# machine that has nothing but Node.js and git:
#
#   curl -fsSL https://raw.githubusercontent.com/alfahluzi/pi-web/custom/install.sh | sh
#
# Run from a clone, ./install.sh installs that checkout instead:
#
#   ./install.sh             update, install dependencies, build, link
#   ./install.sh --no-deps   keep node_modules, rebuild only
#   ./install.sh --restart   stop the pm2 app serving this checkout and start it
#                            again after the build
#   ./install.sh --check     print what would happen, change nothing
#
set -eu

REPO_URL="${PI_WEB_REPO:-https://github.com/alfahluzi/pi-web.git}"
BRANCH="${PI_WEB_BRANCH:-custom}"
CLONE_DIR="${PI_WEB_DIR:-$HOME/pi-web}"
PACKAGE_NAME="@agegr/pi-web"
MIN_NODE="22.19.0"

DO_DEPS=1
RESTART=0
CHECK_ONLY=0
stopped_apps=""

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Update a pi-web checkout, install its dependencies, build .next, and link the
checkout as the global `pi-web` command. With no checkout beside the script it
clones the fork into $PI_WEB_DIR first.

  --no-deps     skip `npm ci`; rebuild with the node_modules already present
  --restart     stop the pm2 app that serves this checkout before the build and
                start it again afterwards
  --check       print what would happen and change nothing
  -h, --help    show this help

Environment:
  PI_WEB_DIR     checkout to install, cloned when missing (default: ~/pi-web)
  PI_WEB_REPO    repository to clone (default: https://github.com/alfahluzi/pi-web.git)
  PI_WEB_BRANCH  branch to clone and follow (default: custom)
EOF
}

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_node() {
  command -v node >/dev/null 2>&1 || die "Node.js $MIN_NODE or newer is required, but node is not on PATH."
  node -e '
    const have = process.versions.node.split(".").map(Number);
    const need = process.argv[1].split(".").map(Number);
    const diff = have[0] - need[0] || have[1] - need[1] || have[2] - need[2];
    process.exit(diff >= 0 ? 0 : 1);
  ' "$MIN_NODE" || die "Node.js $MIN_NODE or newer is required (found $(node --version))."
}

# The pm2 app this script stopped, restarted on any exit path so a failed build
# never leaves the machine without its server.
restore_services() {
  trap - 0
  status=$?
  if [ -n "$stopped_apps" ]; then
    for app in $stopped_apps; do
      printf '==> Restarting pm2 app %s\n' "$app"
      pm2 restart "$app" >/dev/null 2>&1 || warn "pm2 restart $app failed"
    done
  fi
  exit "$status"
}

# Next.js servers whose working directory is this checkout. Any of them has
# .next/ open, and a build would replace the files under it.
detect_serving() {
  node -e '
    const fs = require("fs");
    let target;
    try { target = fs.realpathSync(process.argv[1]); } catch { process.exit(0); }
    if (process.platform !== "linux") process.exit(0);
    const real = (path) => { try { return fs.realpathSync(path); } catch { return null; } };
    const rows = [];
    for (const pid of fs.readdirSync("/proc")) {
      if (!/^[0-9]+$/.test(pid)) continue;
      if (Number(pid) === process.pid || Number(pid) === process.ppid) continue;
      if (real("/proc/" + pid + "/cwd") !== target) continue;
      let cmd = "";
      try {
        cmd = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\u0000").filter(Boolean).join(" ");
      } catch { continue; }
      if (!/next-server|node_modules\/next\/dist\/bin\/next|bin\/pi-web(\.js)?(\s|$)/.test(cmd)) continue;
      if (/install\.sh/.test(cmd)) continue;
      rows.push("  pid " + pid + ": " + cmd);
    }
    if (rows.length) process.stdout.write(rows.join("\n") + "\n");
  ' "$1"
}

# pm2 apps whose script is this checkout's bin/pi-web.js (the global command is
# a symlink to it, so the app runs this source tree).
detect_pm2_apps() {
  command -v pm2 >/dev/null 2>&1 || return 0
  { pm2 jlist 2>/dev/null || true; } | node -e '
    const fs = require("fs");
    let target;
    try { target = fs.realpathSync(process.argv[1]) + "/bin/pi-web.js"; } catch { process.exit(0); }
    let raw = "";
    try { raw = fs.readFileSync(0, "utf8"); } catch { process.exit(0); }
    let apps;
    try { apps = JSON.parse(raw); } catch { process.exit(0); }
    const names = [];
    for (const app of Array.isArray(apps) ? apps : []) {
      if (!app || typeof app.name !== "string") continue;
      const env = app.pm2_env && typeof app.pm2_env === "object" ? app.pm2_env : {};
      const execPath = typeof app.pm_exec_path === "string" ? app.pm_exec_path : env.pm_exec_path;
      const cwd = typeof app.pm_cwd === "string" ? app.pm_cwd : env.pm_cwd;
      let matches = false;
      if (typeof execPath === "string") {
        try { matches = fs.realpathSync(execPath) === target; } catch { matches = false; }
      }
      if (!matches && typeof cwd === "string") {
        try { matches = fs.realpathSync(cwd) === fs.realpathSync(process.argv[1]); } catch { matches = false; }
      }
      if (matches) names.push(app.name);
    }
    if (names.length) process.stdout.write(names.join("\n") + "\n");
  ' "$1"
}

update_checkout() {
  if [ ! -d "$src/.git" ]; then
    warn "$src is not a git repository; building it as it is"
    return 0
  fi
  branch="$(git -C "$src" rev-parse --abbrev-ref HEAD)"
  if [ -n "$(git -C "$src" status --porcelain -uno)" ]; then
    warn "uncommitted changes in $src; skipping git pull"
    return 0
  fi
  if ! git -C "$src" rev-parse --verify --quiet "origin/$branch" >/dev/null; then
    warn "no origin/$branch to pull from; building the checkout as it is"
    return 0
  fi
  if ! git -C "$src" fetch --prune origin; then
    warn "could not reach $REPO_URL; building the checkout as it is"
    return 0
  fi
  before="$(git -C "$src" rev-parse --short HEAD)"
  if git -C "$src" merge --ff-only "origin/$branch" >/dev/null 2>&1; then
    after="$(git -C "$src" rev-parse --short HEAD)"
    if [ "$before" = "$after" ]; then
      say "$branch is up to date at $after"
    else
      say "$branch updated $before -> $after"
    fi
  else
    warn "$branch has diverged from origin/$branch; building the checkout as it is"
  fi
}

build_checkout() {
  if [ "$DO_DEPS" = 1 ]; then
    say "Installing dependencies"
    # --include=dev: the build needs the devDependencies, and npm drops them when
    # NODE_ENV=production happens to be set in the caller's environment.
    if [ -f "$src/package-lock.json" ]; then
      ( cd "$src" && npm ci --include=dev --no-audit --no-fund )
    else
      ( cd "$src" && npm install --include=dev --no-audit --no-fund )
    fi
  fi
  say "Building .next"
  ( cd "$src" && npm run build )
  if [ ! -f "$src/.next/BUILD_ID" ]; then
    die "the build left no .next/BUILD_ID behind; the build did not finish"
  fi
}

install_global() {
  dest="$1/$PACKAGE_NAME"
  # npm 11.19+ skips install scripts unless they are allowed by name, and this
  # package needs its postinstall on macOS (node-pty's spawn-helper modes).
  # Older npm has no such option and runs install scripts anyway.
  allow_scripts=""
  if [ -L "$dest" ] && [ "$(cd "$dest" && pwd -P)" = "$src" ]; then
    say "The global command already links to this checkout ($dest)"
    return 0
  fi
  if [ -e "$dest" ]; then
    say "Replacing the package at $dest"
  fi
  if npm install --help 2>/dev/null | grep -q -- "--allow-scripts"; then
    allow_scripts="--allow-scripts=$PACKAGE_NAME"
  fi
  say "Linking the global pi-web command"
  ( cd "$src" && npm install -g . --no-audit --no-fund $allow_scripts )
}

report() {
  bin="$(npm prefix -g)/bin/pi-web"
  if [ ! -x "$bin" ]; then
    bin="$(command -v pi-web || true)"
  fi
  if [ -z "$bin" ]; then
    warn "pi-web is not on PATH; add $(npm prefix -g)/bin to it"
  else
    version="$("$bin" version 2>/dev/null || true)"
    say "pi-web ${version:-?} from $src"
    say "Command: $bin"
  fi
  say "Start it with: pi-web"
}

# --- options ---------------------------------------------------------------

for arg in "$@"; do
  case "$arg" in
    --no-deps) DO_DEPS=0 ;;
    --restart) RESTART=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      usage >&2
      die "unknown option: $arg"
      ;;
  esac
done

# --- checkout --------------------------------------------------------------

require_node

# Through a pipe $0 is just the shell's own name, so only a script path names
# the checkout to install. dash sets $0 to the bare file name (`sh install.sh`),
# which resolves against the working directory.
src=""
if [ "$0" != "${0##*/}" ]; then
  src="$(cd "$(dirname "$0")" 2>/dev/null && pwd -P || true)"
elif [ -f "$0" ]; then
  src="$(pwd -P)"
fi
if [ -n "$src" ] && [ -f "$src/package.json" ]; then
  name="$(node -p 'require(process.argv[1]).name' "$src/package.json")"
  [ "$name" = "$PACKAGE_NAME" ] || src=""
fi

if [ -z "$src" ]; then
  if [ -d "$CLONE_DIR/.git" ]; then
    src="$(cd "$CLONE_DIR" && pwd -P)"
    name="$(node -p 'require(process.argv[1]).name' "$src/package.json")"
    [ "$name" = "$PACKAGE_NAME" ] || die "$src/package.json is $name, not $PACKAGE_NAME"
  elif [ "$CHECK_ONLY" = 1 ]; then
    say "No checkout at $CLONE_DIR yet"
    say "Node $(node --version), npm $(npm --version)"
    say "An install would run: git clone --branch $BRANCH $REPO_URL $CLONE_DIR"
    say "Rerun without --check to clone and install"
    exit 0
  else
    command -v git >/dev/null 2>&1 || die "git is required to clone $REPO_URL."
    say "Cloning $REPO_URL (branch $BRANCH) into $CLONE_DIR"
    git clone --branch "$BRANCH" "$REPO_URL" "$CLONE_DIR"
    src="$(cd "$CLONE_DIR" && pwd -P)"
  fi
fi

global_root="$(npm root -g)"

# --- check only ------------------------------------------------------------

if [ "$CHECK_ONLY" = 1 ]; then
  say "Checkout: $src"
  say "Node $(node --version), npm $(npm --version), global root $global_root"
  if [ -d "$src/.git" ]; then
    say "Branch $(git -C "$src" rev-parse --abbrev-ref HEAD) at $(git -C "$src" rev-parse --short HEAD)"
    dirty="$(git -C "$src" status --porcelain -uno)"
    if [ -n "$dirty" ]; then
      say "Uncommitted changes, so git pull would be skipped:"
      printf '%s\n' "$dirty"
    fi
  fi
  dest="$global_root/$PACKAGE_NAME"
  if [ -L "$dest" ] && [ "$(cd "$dest" && pwd -P)" = "$src" ]; then
    say "Global command: links to this checkout"
  elif [ -e "$dest" ]; then
    say "Global command: $dest would be replaced"
  else
    say "Global command: not installed"
  fi
  serving="$(detect_serving "$src")"
  if [ -n "$serving" ]; then
    say "Serving this checkout (a build would need it stopped):"
    printf '%s\n' "$serving"
  fi
  pm2_apps="$(detect_pm2_apps "$src")"
  if [ -n "$pm2_apps" ]; then
    say "pm2 apps serving this checkout: $(printf '%s' "$pm2_apps" | tr '\n' ' ')"
  fi
  if [ -f "$src/.next/BUILD_ID" ]; then
    say "Build present: $(cat "$src/.next/BUILD_ID")"
  else
    say "No build present"
  fi
  say "Rerun without --check to install"
  exit 0
fi

# --- install ---------------------------------------------------------------

trap restore_services 0

say "Checkout: $src"
update_checkout

serving="$(detect_serving "$src")"
pm2_apps="$(detect_pm2_apps "$src")"
if [ -n "$serving" ] || [ -n "$pm2_apps" ]; then
  if [ "$RESTART" = 1 ] && [ -n "$pm2_apps" ]; then
    for app in $pm2_apps; do
      say "Stopping pm2 app $app"
      pm2 stop "$app" >/dev/null
      stopped_apps="$stopped_apps $app"
    done
    sleep 2
    serving="$(detect_serving "$src")"
  fi
  if [ -n "$serving" ]; then
    die "pi-web is serving this checkout, and a build would replace its .next:
$serving
Stop it first (pi-web stop, or pm2 stop <app>), or rerun with --restart."
  fi
fi

build_checkout
install_global "$global_root"

if [ -n "$stopped_apps" ]; then
  for app in $stopped_apps; do
    say "Starting pm2 app $app"
    pm2 restart "$app" >/dev/null
  done
  stopped_apps=""
fi

report
