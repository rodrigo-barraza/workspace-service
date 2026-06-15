#!/bin/bash
# ============================================================
# Workspace Service — Build & Deploy to Synology NAS
#
# Thin wrapper — all logic lives in deploy-kit/lib.sh
#
# When changes are detected in the tray-app/ directory, the
# Electron system tray app is automatically built and its
# installers are uploaded to MinIO alongside the Docker deploy.
#
# Usage:
#   npm run deploy              # full deploy
#   npm run deploy -- --dry-run # validate without deploying
#   npm run deploy -- --skip-pull
#   npm run deploy -- --no-cache
#   npm run deploy -- --skip-tray-app  # skip tray app build even if changed
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="workspace-service"
DISPLAY_NAME="🔌 Workspace Service"

# ── Parse flags (before lib.sh consumes args) ─────────────────
SKIP_TRAY_APP=false
for arg in "$@"; do
  case "$arg" in
    --skip-tray-app) SKIP_TRAY_APP=true ;;
  esac
done

# ── Detect tray-app changes against last deployed SHA ─────────
tray_app_has_changes() {
  local last_tray_sha_file="${SCRIPT_DIR}/../deploy-kit/.deploy-state/workspace-service.tray-app.sha"
  local tray_dir="${SCRIPT_DIR}/tray-app"

  if [ ! -d "$tray_dir" ]; then
    return 1
  fi

  # If no previous SHA marker, always build
  if [ ! -f "$last_tray_sha_file" ]; then
    return 0
  fi

  local last_sha
  last_sha=$(cat "$last_tray_sha_file" 2>/dev/null || echo "")
  if [ -z "$last_sha" ]; then
    return 0
  fi

  # Check for changes in tray-app/ since last deployed SHA
  if ! (cd "$SCRIPT_DIR" && git diff --quiet "$last_sha" -- tray-app/ 2>/dev/null); then
    return 0
  fi

  # Check for untracked files
  if [ -n "$(cd "$SCRIPT_DIR" && git ls-files --others --exclude-standard tray-app/ 2>/dev/null)" ]; then
    return 0
  fi

  return 1
}

# ── Save tray-app SHA after successful build ──────────────────
save_tray_app_sha() {
  local sha_file="${SCRIPT_DIR}/../deploy-kit/.deploy-state/workspace-service.tray-app.sha"
  local current_sha
  current_sha=$(cd "$SCRIPT_DIR" && git rev-parse HEAD 2>/dev/null || echo "")
  if [ -n "$current_sha" ]; then
    mkdir -p "$(dirname "$sha_file")"
    echo "$current_sha" > "$sha_file"
  fi
}

# ── Post-deploy hook: auto-build tray app if changed ──────────
EXTRA_SSH_SYNC() {
  if $SKIP_TRAY_APP; then
    return 0
  fi

  if tray_app_has_changes; then
    echo ""
    echo "━━━ Tray app changes detected — building & uploading installers ━━━"
    if bash "${SCRIPT_DIR}/tray-app/build-and-upload.sh"; then
      save_tray_app_sha
    else
      echo "⚠  Tray app build failed — Docker deploy was still successful"
    fi
  fi
}

source "${SCRIPT_DIR}/../deploy-kit/lib.sh"
