#!/usr/bin/env bash
#
# Promote the local (patched) pi-web build in this directory to the globally
# installed `pi-web` command used by pm2.
#
# What it does:
#   1. Stops the `pi-web-custom` pm2 app (this kills any running agent session,
#      so run it when you are not in the middle of a pi-web conversation).
#   2. Symlinks @agegr/pi-web -> this directory, so `~/.local/bin/pi-web` and
#      `pm2 restart pi-web-custom` keep working unchanged.
#   3. Starts the app again and saves the pm2 process list.
#
# This git repository is the single source of truth; the original npm install and
# its @agegr/pi-web.npm-backup copy were removed on 2026-10-01. The former
# `pi-web` app on port 4200 was removed on the same day, so this fork runs as
# `pi-web-custom` on port 4201 only.
#
# To roll back to an upstream release instead:
#   pm2 delete pi-web-custom
#   rm ~/.local/lib/node_modules/@agegr/pi-web
#   npm install -g @agegr/pi-web@<version>
#   pm2 start ~/pi-web.ecosystem.config.js --only pi-web-custom && pm2 save
# (or keep the symlink and check out the matching tag in this checkout).
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_MODULES="$HOME/.local/lib/node_modules"
DEST="$NODE_MODULES/@agegr/pi-web"

if [ ! -f "$SRC/.next/BUILD_ID" ]; then
  echo "No build found in $SRC/.next. Run 'npm run build' first." >&2
  exit 1
fi

ECOSYSTEM="$HOME/pi-web.ecosystem.config.js"

# Delete (not just stop) so the app is recreated from the ecosystem file below.
# `pm2 start pi-web-custom` by name would replay the saved env, which would miss
# a newly added PI_WEB_EXTENSION_MODE in pi-web.env.
echo "==> Stopping and removing the pi-web-custom app"
pm2 delete pi-web-custom >/dev/null 2>&1 || true

if [ -L "$DEST" ]; then
  echo "==> $DEST is already a symlink; replacing it"
  rm "$DEST"
else
  echo "==> Removing existing install at $DEST (git is the source of truth now)"
  rm -rf "$DEST"
fi

echo "==> Linking $DEST -> $SRC"
ln -s "$SRC" "$DEST"

if [ -d "$NODE_MODULES/@agegr/pi-web.npm-backup" ]; then
  echo "==> Removing stale npm backup at $NODE_MODULES/@agegr/pi-web.npm-backup"
  rm -rf "$NODE_MODULES/@agegr/pi-web.npm-backup"
fi

echo "==> Starting pi-web-custom from $ECOSYSTEM"
pm2 start "$ECOSYSTEM" --only pi-web-custom
pm2 save >/dev/null 2>&1 || true

echo
echo "Done. pi-web-custom now runs the local build from:"
echo "  $SRC"
echo "Check it with: pm2 logs pi-web-custom --lines 30"
