#!/usr/bin/env bash
#
# Promote the local (patched) pi-web build in this directory to the globally
# installed `pi-web` command used by pm2.
#
# What it does:
#   1. Stops the `pi-web` pm2 app (loopback :4104). This kills any running agent
#      session, including the one this script was started from, so run it when
#      you are not in the middle of a pi-web conversation — or start it detached:
#        setsid nohup bash -c 'npm run build && ./deploy-to-pi-web.sh' \
#          > /tmp/pi-web-deploy.log 2>&1 < /dev/null &
#   2. Symlinks @agegr/pi-web -> this directory, so `~/.local/bin/pi-web` and
#      `pm2 start ~/pi-web.ecosystem.config.js` keep working unchanged.
#   3. Starts the app again from ~/pi-web.ecosystem.config.js and saves the pm2
#      process list.
#
# This git repository is the single source of truth; the original npm install and
# its @agegr/pi-web.npm-backup copy were removed on 2026-10-01. The app name is
# `pi-web` on port 4104 (it was `pi-web-custom` on 4201 before 2026-10-26).
#
# To roll back to an upstream release instead:
#   pm2 delete pi-web
#   rm ~/.local/lib/node_modules/@agegr/pi-web
#   npm install -g @agegr/pi-web@<version>
#   pm2 start ~/pi-web.ecosystem.config.js --only pi-web && pm2 save
# (or keep the symlink and check out the matching tag in this checkout).
#
set -euo pipefail

APP_NAME="${PI_WEB_PM2_APP:-pi-web}"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_MODULES="$HOME/.local/lib/node_modules"
DEST="$NODE_MODULES/@agegr/pi-web"

if [ ! -f "$SRC/.next/BUILD_ID" ]; then
  echo "No build found in $SRC/.next. Run 'npm run build' first." >&2
  exit 1
fi

ECOSYSTEM="$HOME/pi-web.ecosystem.config.js"

if [ ! -f "$ECOSYSTEM" ]; then
  echo "No pm2 ecosystem file at $ECOSYSTEM." >&2
  exit 1
fi

# Delete (not just stop) so the app is recreated from the ecosystem file below.
# `pm2 start "$APP_NAME"` by name would replay the saved env, which would miss a
# newly added PI_WEB_EXTENSION_MODE in pi-web.env.
echo "==> Stopping and removing the $APP_NAME app"
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true

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

echo "==> Starting $APP_NAME from $ECOSYSTEM"
pm2 start "$ECOSYSTEM" --only "$APP_NAME"
pm2 save >/dev/null 2>&1 || true

PORT_LINE="$(grep -o "\-\-port [0-9]*" "$ECOSYSTEM" | head -1 || true)"

echo
echo "Done. $APP_NAME now runs the local build from:"
echo "  $SRC"
echo "  ${PORT_LINE:-see $ECOSYSTEM}"
echo "Check it with: pm2 logs $APP_NAME --lines 30"
