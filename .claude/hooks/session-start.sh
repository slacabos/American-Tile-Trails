#!/bin/bash
# Prepares a Claude Code cloud session: installs npm dependencies and makes a
# Chromium available to Playwright, so lint, type checks, unit tests, stories
# and end-to-end tests can all run.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# --no-save keeps an older npm from rewriting package-lock.json.
npm install --no-save --no-audit --no-fund

# The cloud image ships a Chromium under $PLAYWRIGHT_BROWSERS_PATH but cannot
# download the exact build this repo's Playwright pins. Point the pinned
# revision at the preinstalled build so `playwright test` and the Storybook
# browser tests find it.
browsers="${PLAYWRIGHT_BROWSERS_PATH:-}"
if [ -n "$browsers" ] && [ -d "$browsers" ]; then
  want=$(node -p 'JSON.parse(require("fs").readFileSync("node_modules/playwright-core/browsers.json")).browsers.find(b => b.name === "chromium").revision')
  have=$(ls -d "$browsers"/chromium-[0-9]* 2>/dev/null | sed 's/.*-//' | sort -n | tail -1)
  if [ -n "$have" ] && [ "$want" != "$have" ]; then
    full="$browsers/chromium-$want"
    shell="$browsers/chromium_headless_shell-$want"
    if [ ! -e "$full/INSTALLATION_COMPLETE" ]; then
      mkdir -p "$full"
      ln -sfn "$browsers/chromium-$have/chrome-linux" "$full/chrome-linux64"
      touch "$full/INSTALLATION_COMPLETE" "$full/DEPENDENCIES_VALIDATED"
    fi
    if [ ! -e "$shell/INSTALLATION_COMPLETE" ] && [ -d "$browsers/chromium_headless_shell-$have/chrome-linux" ]; then
      mkdir -p "$shell/chrome-headless-shell-linux64"
      for f in "$browsers/chromium_headless_shell-$have/chrome-linux"/*; do
        ln -sfn "$f" "$shell/chrome-headless-shell-linux64/"
      done
      ln -sfn headless_shell "$shell/chrome-headless-shell-linux64/chrome-headless-shell"
      touch "$shell/INSTALLATION_COMPLETE" "$shell/DEPENDENCIES_VALIDATED"
    fi
  fi
fi
