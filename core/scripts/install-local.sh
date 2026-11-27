#!/bin/sh
# Builds a release binary into ~/.local/bin (replacing any older one), then
# restarts the core the planned way so running terminals pick up the new build
# (never handing this shell's environment to a core it has to start).
set -eu
cd "$(dirname "$0")/.."
nice -n 10 cargo build --release
bin="${HC_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$bin"
if [ "$(uname -s)" = Darwin ]; then
  app="target/release/Finch Core.app"
  rm -rf "$app"
  sh scripts/mac-bundle target/release/finch-core "$app"
  bash scripts/mac-sign "$app"
  "$app/Contents/MacOS/finch-core" --hc-install-bundle "$app/Contents/MacOS/finch-core" "$bin/finch-core"
else
  install -m 755 target/release/finch-core "$bin/finch-core.new"
  mv -f "$bin/finch-core.new" "$bin/finch-core"
fi
[ -e "$bin/hc" ] || [ -L "$bin/hc" ] || ln -s finch-core "$bin/hc"
sh scripts/restart-core.sh "$bin/finch-core"
