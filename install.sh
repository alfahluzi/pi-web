#!/bin/sh
#
# Install this pi-web fork as the global `pi-web` command.
#
# With no checkout to install, it downloads the prebuilt release for the newest
# tag (or --tag), checks its published sha256, unpacks it, and links it, so a
# machine that has nothing but Node.js and tar needs no build:
#
#   curl -fsSL https://raw.githubusercontent.com/alfahluzi/pi-web/custom/install.sh | sh
#
# Run from a clone, ./install.sh installs that checkout from source instead:
#
#   ./install.sh             update, install dependencies, build, link
#   ./install.sh --no-deps   keep node_modules, rebuild only
#   ./install.sh --source    clone the branch and build it, as the release-less
#                            install used to
#   ./install.sh --restart   stop the pm2 app serving this install and start it
#                            again afterwards
#   ./install.sh --check     print what would happen, change nothing
#
set -eu

REPO_URL="${PI_WEB_REPO:-https://github.com/alfahluzi/pi-web.git}"
BRANCH="${PI_WEB_BRANCH:-custom}"
CLONE_DIR="${PI_WEB_DIR:-$HOME/pi-web}"
PACKAGE_NAME="@agegr/pi-web"
MIN_NODE="22.19.0"

# A release of this fork carries the finished package as assets: the tarball
# `npm pack` writes, its sha256, the lockfile `npm ci` needs, and this script.
# Nothing is published to npm; that name belongs to upstream.
RELEASE_REPO="${PI_WEB_RELEASE_REPO:-alfahluzi/pi-web}"
ASSET_PREFIX="agegr-pi-web"
DOWNLOAD_BASE="https://github.com/$RELEASE_REPO/releases/download"

MODE=""
DO_DEPS=1
RESTART=0
CHECK_ONLY=0
SOURCE_ONLY=0
TAG=""
rel_tag=""
stopped_apps=""

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Install the global `pi-web` command. Run from a clone (or with --source) it
updates a checkout, installs its dependencies, builds .next, and links it into
npm's global prefix. With no checkout anywhere it downloads the prebuilt release
of the newest tag into $PI_WEB_DIR, checks its sha256, unpacks it, installs its
production dependencies, and links that.

  --tag <tag>   use that published tag (for example v0.17.0-0.0): the release to
                download, or the checkout to switch to
  --source      clone and build the branch instead of installing a release
  --no-deps     source installs only: skip `npm ci`, rebuild with the
                node_modules already present
  --restart     stop the pm2 app that serves this install before it is replaced
                and start it again afterwards
  --check       print what would happen and change nothing
  -h, --help    show this help

Environment:
  PI_WEB_DIR          installation directory (default: ~/pi-web)
  PI_WEB_RELEASE_REPO fork whose releases carry the prebuilt package
                      (default: alfahluzi/pi-web)
  PI_WEB_REPO         repository to clone in a source install
                      (default: https://github.com/alfahluzi/pi-web.git)
  PI_WEB_BRANCH       branch a source install follows (default: custom)
  GITHUB_TOKEN        token for the release lookup and download, when the API
                      rate-limits the anonymous one
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
  # The status has to be read before `trap - 0` runs: that command succeeds, so
  # `$?` after it is always 0 and a failed install would report success.
  status=$?
  trap - 0
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
  if [ "$branch" = "HEAD" ]; then
    warn "$src is at a tag (detached HEAD); install another with --tag <tag>, or follow the branch again with: git -C $src checkout $BRANCH"
    return 0
  fi
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

# Move a checkout onto a published tag (detached HEAD) so the install is
# reproducible. Uncommitted work would be lost by the checkout, so it refuses.
switch_to_tag() {
  if [ ! -d "$src/.git" ]; then
    warn "$src is not a git repository; cannot install tag $TAG, building it as it is"
    return 0
  fi
  if [ -n "$(git -C "$src" status --porcelain -uno)" ]; then
    die "uncommitted changes in $src; commit or stash them before installing tag $TAG"
  fi
  if ! git -C "$src" rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null; then
    if ! git -C "$src" fetch --tags origin; then
      die "could not fetch tags from $REPO_URL, and tag $TAG is not in $src"
    fi
  fi
  git -C "$src" rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null \
    || die "no tag $TAG in $REPO_URL"
  if [ "$(git -C "$src" rev-parse --short HEAD)" = "$(git -C "$src" rev-parse --short "refs/tags/$TAG^{commit}")" ]; then
    say "Already at tag $TAG"
    return 0
  fi
  say "Switching to tag $TAG (detached HEAD)"
  git -C "$src" checkout --quiet "$TAG"
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
    if [ -n "$TAG" ]; then
      say "pi-web ${version:-?} from $src (tag $TAG)"
    else
      say "pi-web ${version:-?} from $src"
    fi
    say "Command: $bin"
  fi
  say "Start it with: pi-web"
}

# --- release install -------------------------------------------------------

asset_url() { # tag file
  printf '%s/%s/%s' "$DOWNLOAD_BASE" "$1" "$2"
}

# The tag of the newest published release. Non-zero status when the API cannot
# be read (rate limit, offline, or no release yet).
latest_release_tag() {
  node -e '
    const [repo, token] = process.argv.slice(1);
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "pi-web-install" };
    if (token) headers.Authorization = `Bearer ${token}`;
    fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(15000),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
        return response.json();
      })
      .then((release) => { process.stdout.write(String(release.tag_name ?? "")); })
      .catch((error) => { console.error(error.message); process.exit(1); });
  ' "$RELEASE_REPO" "${GITHUB_TOKEN:-}"
}

# Download through Node, so the install needs no downloader on PATH.
download() { # url destination
  node -e '
    const [url, destination, token] = process.argv.slice(1);
    const headers = { "User-Agent": "pi-web-install" };
    if (token) headers.Authorization = `Bearer ${token}`;
    fetch(url, { headers, signal: AbortSignal.timeout(300000) })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        return response.arrayBuffer();
      })
      .then((body) => { require("fs").writeFileSync(destination, Buffer.from(body)); })
      .catch((error) => { console.error(error.message); process.exit(1); });
  ' "$1" "$2" "${GITHUB_TOKEN:-}"
}

# The asset carries `<sha256>  <file>`, as sha256sum writes it.
verify_sha256() { # file sidecar
  node -e '
    const fs = require("fs");
    const crypto = require("crypto");
    const [file, sidecar] = process.argv.slice(1);
    const expected = String(fs.readFileSync(sidecar, "utf8")).trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      console.error("the checksum asset holds no sha256");
      process.exit(1);
    }
    const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (actual !== expected) {
      console.error(`checksum mismatch: the release publishes ${expected}, the download is ${actual}`);
      process.exit(1);
    }
  ' "$1" "$2"
}

# Download, verify, unpack and install the release's production dependencies.
# The unpack happens in a temporary directory and the live install is moved only
# after everything succeeded, so a failed download or npm leaves it working.
install_release() {
  release="$1"
  version="${release#v}"
  tarball="$ASSET_PREFIX-$version.tgz"
  work="$(mktemp -d "${TMPDIR:-/tmp}/pi-web-release.XXXXXX")" \
    || die "could not create a temporary directory for the download"

  say "Downloading $tarball from release $release"
  download "$(asset_url "$release" "$tarball")" "$work/$tarball" \
    || die "could not download $(asset_url "$release" "$tarball")"
  download "$(asset_url "$release" "$tarball.sha256")" "$work/$tarball.sha256" \
    || die "release $release publishes no $tarball.sha256; the download cannot be verified"
  verify_sha256 "$work/$tarball" "$work/$tarball.sha256" \
    || die "the downloaded $tarball does not match the checksum release $release publishes"
  say "Checksum matches"

  command -v tar >/dev/null 2>&1 || die "tar is required to unpack $tarball"
  mkdir "$work/unpacked"
  tar -xzf "$work/$tarball" -C "$work/unpacked" \
    || die "could not unpack $work/$tarball"
  [ -f "$work/unpacked/package/.next/BUILD_ID" ] \
    || die "release $release carries no .next/BUILD_ID; it is not a finished build"
  say "Release holds build $(cat "$work/unpacked/package/.next/BUILD_ID")"

  # npm leaves the lockfile out of a packed tarball, so the release publishes it
  # as a second asset; it goes back before `npm ci` resolves the dependencies.
  if download "$(asset_url "$release" "package-lock.json")" "$work/unpacked/package/package-lock.json" 2>/dev/null; then
    :
  else
    rm -f "$work/unpacked/package/package-lock.json"
    warn "release $release publishes no package-lock.json; resolving dependencies from their ranges"
  fi

  if [ "$DO_DEPS" = 1 ]; then
    say "Installing production dependencies"
    if [ -f "$work/unpacked/package/package-lock.json" ]; then
      ( cd "$work/unpacked/package" && npm ci --omit=dev --no-audit --no-fund ) \
        || die "npm ci failed in $work/unpacked/package"
    else
      ( cd "$work/unpacked/package" && npm install --omit=dev --no-audit --no-fund ) \
        || die "npm install failed in $work/unpacked/package"
    fi
  fi

  say "Installing into $CLONE_DIR"
  previous=""
  if [ -e "$CLONE_DIR" ]; then
    previous="$CLONE_DIR.old.$$"
    mv "$CLONE_DIR" "$previous" || die "could not move $CLONE_DIR aside"
  fi
  if ! mv "$work/unpacked/package" "$CLONE_DIR"; then
    if [ -n "$previous" ]; then mv "$previous" "$CLONE_DIR"; fi
    die "could not move the unpacked release into $CLONE_DIR"
  fi
  if [ -n "$previous" ]; then rm -rf "$previous"; fi
  rm -rf "$work"
}

# Whatever serves this install holds `.next` open: a build or a release swap
# would replace the files under it. --restart stops the pm2 app itself.
stop_for_replacement() { # directory
  target="$1"
  serving="$(detect_serving "$target")"
  pm2_apps="$(detect_pm2_apps "$target")"
  if [ -z "$serving" ] && [ -z "$pm2_apps" ]; then
    return 0
  fi
  if [ "$RESTART" = 1 ] && [ -n "$pm2_apps" ]; then
    for app in $pm2_apps; do
      say "Stopping pm2 app $app"
      pm2 stop "$app" >/dev/null
      stopped_apps="$stopped_apps $app"
    done
    sleep 2
    serving="$(detect_serving "$target")"
  fi
  if [ -n "$serving" ]; then
    die "pi-web is serving $target, and installing would replace its .next:
$serving
Stop it first (pi-web stop, or pm2 stop <app>), or rerun with --restart."
  fi
}

# --- options ---------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      if [ $# -lt 2 ]; then
        usage >&2
        die "--tag needs a value, for example: --tag v0.17.0-0.0"
      fi
      TAG="$2"
      shift
      ;;
    --tag=*) TAG="${1#--tag=}" ;;
    --source) SOURCE_ONLY=1 ;;
    --no-deps) DO_DEPS=0 ;;
    --restart) RESTART=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift
done

# --- checkout --------------------------------------------------------------

require_node

# Through a pipe $0 is just the shell's own name, so only a script path names
# the checkout to install. dash sets $0 to the bare file name (`sh install.sh`),
# which resolves against the working directory.
src=""
if [ "$0" != "${0##*/}" ]; then
  candidate="$(cd "$(dirname "$0")" 2>/dev/null && pwd -P || true)"
elif [ -f "$0" ]; then
  candidate="$(pwd -P)"
else
  candidate=""
fi
if [ -n "$candidate" ] && [ -f "$candidate/package.json" ]; then
  name="$(node -p 'require(process.argv[1]).name' "$candidate/package.json" 2>/dev/null || true)"
  if [ "$name" = "$PACKAGE_NAME" ]; then src="$candidate"; fi
fi

# A checkout beside the script, an existing checkout at $CLONE_DIR, or --source
# keeps the source install; everything else installs the published release.
MODE=release
if [ -n "$src" ] || [ "$SOURCE_ONLY" = 1 ] || [ -d "$CLONE_DIR/.git" ]; then
  MODE=source
fi

if [ "$MODE" = source ] && [ -z "$src" ]; then
  if [ -d "$CLONE_DIR/.git" ]; then
    src="$(cd "$CLONE_DIR" && pwd -P)"
    name="$(node -p 'require(process.argv[1]).name' "$src/package.json")"
    [ "$name" = "$PACKAGE_NAME" ] || die "$src/package.json is $name, not $PACKAGE_NAME"
  elif [ "$CHECK_ONLY" = 1 ]; then
    say "No checkout at $CLONE_DIR yet"
    say "Node $(node --version), npm $(npm --version)"
    if [ -n "$TAG" ]; then
      say "An install would run: git clone --branch $TAG $REPO_URL $CLONE_DIR"
    else
      say "An install would run: git clone --branch $BRANCH $REPO_URL $CLONE_DIR"
    fi
    say "Rerun without --check to clone and install"
    exit 0
  else
    command -v git >/dev/null 2>&1 || die "git is required to clone $REPO_URL."
    if [ -e "$CLONE_DIR" ]; then
      die "$CLONE_DIR exists and is not a git checkout; move it aside first"
    fi
    if [ -n "$TAG" ]; then
      say "Cloning $REPO_URL (tag $TAG) into $CLONE_DIR"
      git clone --branch "$TAG" "$REPO_URL" "$CLONE_DIR"
    else
      say "Cloning $REPO_URL (branch $BRANCH) into $CLONE_DIR"
      git clone --branch "$BRANCH" "$REPO_URL" "$CLONE_DIR"
    fi
    src="$(cd "$CLONE_DIR" && pwd -P)"
  fi
fi

if [ "$MODE" = release ]; then
  if [ "$DO_DEPS" = 0 ]; then
    die "--no-deps applies to a source install only; a release install brings its dependencies"
  fi
  # The release replaces $CLONE_DIR, so refuse a directory that is not a pi-web
  # install, and nothing else lives there to lose.
  if [ -e "$CLONE_DIR" ]; then
    if [ ! -f "$CLONE_DIR/package.json" ]; then
      die "$CLONE_DIR exists and holds no package.json; move it aside first"
    fi
    name="$(node -p 'require(process.argv[1]).name' "$CLONE_DIR/package.json" 2>/dev/null || true)"
    [ "$name" = "$PACKAGE_NAME" ] || die "$CLONE_DIR holds $name, not $PACKAGE_NAME; move it aside first"
  fi
  if [ -n "$TAG" ]; then
    rel_tag="$TAG"
  elif [ "$CHECK_ONLY" = 1 ]; then
    rel_tag=""
  else
    say "Looking up the newest release of $RELEASE_REPO"
    rel_tag="$(latest_release_tag)" \
      || die "could not read the newest release of $RELEASE_REPO; name one with --tag <tag>"
    [ -n "$rel_tag" ] || die "$RELEASE_REPO publishes no release yet; name one with --tag <tag>"
  fi
  src="$CLONE_DIR"
fi

global_root="$(npm root -g)"

# --- check only ------------------------------------------------------------

if [ "$CHECK_ONLY" = 1 ]; then
  say "Install mode: $MODE ($src)"
  say "Node $(node --version), npm $(npm --version), global root $global_root"
  if [ "$MODE" = release ]; then
    say "Release repository: $RELEASE_REPO"
    if [ -n "$rel_tag" ]; then
      say "Release: $rel_tag (downloads $ASSET_PREFIX-${rel_tag#v}.tgz, its .sha256 and package-lock.json)"
    else
      say "Release: the newest published one (looked up at install time)"
    fi
    if [ -e "$CLONE_DIR" ]; then
      say "Directory to replace: $CLONE_DIR"
    else
      say "Directory to install: $CLONE_DIR (does not exist yet)"
    fi
    dest="$global_root/$PACKAGE_NAME"
    if [ -L "$dest" ] && [ "$(cd "$dest" && pwd -P)" = "$CLONE_DIR" ]; then
      say "Global command: links to that directory"
    elif [ -e "$dest" ]; then
      say "Global command: $dest would be replaced"
    else
      say "Global command: not installed"
    fi
    serving="$(detect_serving "$CLONE_DIR")"
    if [ -n "$serving" ]; then
      say "Serving that directory (the install would need it stopped):"
      printf '%s\n' "$serving"
    fi
    pm2_apps="$(detect_pm2_apps "$CLONE_DIR")"
    if [ -n "$pm2_apps" ]; then
      say "pm2 apps serving that directory: $(printf '%s' "$pm2_apps" | tr '\n' ' ')"
    fi
    say "Rerun without --check to install"
    exit 0
  fi
  if [ -n "$TAG" ]; then
    if git -C "$src" rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null 2>&1; then
      say "Tag to install: $TAG (present)"
    else
      say "Tag to install: $TAG (would be fetched from origin)"
    fi
  fi
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

if [ "$MODE" = release ]; then
  # Repointing the global command away from a source checkout is the one way a
  # release install can surprise a machine that developed this fork.
  dest="$global_root/$PACKAGE_NAME"
  if [ -L "$dest" ]; then
    linked="$(cd "$dest" 2>/dev/null && pwd -P || true)"
    if [ -n "$linked" ] && [ "$linked" != "$CLONE_DIR" ] && [ -d "$linked/.git" ]; then
      warn "the global pi-web command links to the checkout $linked, not to $CLONE_DIR"
      warn "this install repoints it at the release; the checkout is left as it is"
    fi
  fi
  stop_for_replacement "$CLONE_DIR"
  install_release "$rel_tag"
  say "Install: $CLONE_DIR (release $rel_tag, no build)"
else
  say "Checkout: $src"
  if [ -n "$TAG" ]; then
    switch_to_tag
  else
    update_checkout
  fi
  stop_for_replacement "$src"
  build_checkout
fi

install_global "$global_root"

if [ -n "$stopped_apps" ]; then
  for app in $stopped_apps; do
    say "Starting pm2 app $app"
    pm2 restart "$app" >/dev/null
  done
  stopped_apps=""
fi

report
