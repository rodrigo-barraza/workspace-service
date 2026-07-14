#!/bin/bash
# ============================================================
# Build & Upload — Tray App Installers
#
# Builds Electron tray app installers for the specified platform
# and uploads them to MinIO via the tools-service API.
#
# Usage:
#   ./build-and-upload.sh                    # build for current platform
#   ./build-and-upload.sh --platform=win     # build for Windows
#   ./build-and-upload.sh --platform=linux   # build for Linux
#   ./build-and-upload.sh --platform=mac     # build for macOS (both architectures)
#   ./build-and-upload.sh --all              # build for all platforms
#   ./build-and-upload.sh --upload-only      # skip build, upload existing dist/
#   ./build-and-upload.sh --dry-run          # build only, skip upload
#
# Requires:
#   - Node.js and npm
#   - TOOLS_API_URL environment variable (default: https://api.tools.rod.dev)
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="${SCRIPT_DIR}/dist"
TOOLS_API_URL="${TOOLS_API_URL:-https://api.tools.rod.dev}"

# ── Colors ────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

info()    { printf '%s  ℹ %s%s\n' "$CYAN" "$1" "$RESET"; }
ok()      { printf '%s  ✔ %s%s\n' "$GREEN" "$1" "$RESET"; }
warn()    { printf '%s  ⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }
fail()    { printf '%s  ✖ %s%s\n' "$RED" "$1" "$RESET"; exit 1; }

# ── Wine prerequisite (cross-compile Windows NSIS from Linux) ─
ensure_wine_installed() {
  if command -v wine64 >/dev/null 2>&1 || command -v wine >/dev/null 2>&1; then
    return 0
  fi

  info "Wine not found — installing for Windows cross-compilation..."
  sudo dpkg --add-architecture i386 2>&1 | tail -1
  sudo apt-get update -qq 2>&1 | tail -1
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq wine64 wine32 2>&1 | tail -5

  if command -v wine64 >/dev/null 2>&1 || command -v wine >/dev/null 2>&1; then
    ok "Wine installed successfully"
  else
    warn "Wine installation failed — Windows installer will be skipped"
    return 1
  fi
}

step()    { printf '\n%s%s━━━ %s%s\n' "$BOLD" "$CYAN" "$1" "$RESET"; }

# ── Parse flags ───────────────────────────────────────────────
PLATFORM=""
BUILD_ALL=false
UPLOAD_ONLY=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --platform=*)  PLATFORM="${arg#--platform=}" ;;
    --all)         BUILD_ALL=true ;;
    --upload-only) UPLOAD_ONLY=true ;;
    --dry-run)     DRY_RUN=true ;;
  esac
done

# Default to current platform if none specified
# On WSL2, build both Windows + Linux since the deploy serves all platforms.
if [ -z "$PLATFORM" ] && ! $BUILD_ALL; then
  if grep -qi microsoft /proc/version 2>/dev/null; then
    BUILD_ALL=true
    info "Auto-detected WSL2 — building for all platforms (win + linux)"
  else
    case "$(uname -s)" in
      Linux*)   PLATFORM="linux" ;;
      Darwin*)  PLATFORM="mac" ;;
      MINGW*|MSYS*|CYGWIN*) PLATFORM="win" ;;
      *) PLATFORM="linux" ;;
    esac
    info "Auto-detected platform: ${PLATFORM}"
  fi
fi

# ── Build ─────────────────────────────────────────────────────
if ! $UPLOAD_ONLY; then
  step "Installing dependencies"
  cd "$SCRIPT_DIR"
  npm install --no-audit --no-fund 2>&1 | tail -3

  step "Building TypeScript"
  npm run build 2>&1 | tail -5

  step "Building installers"

  # Ensure Wine is available when building Windows targets on Linux/WSL2
  if { $BUILD_ALL || [[ "$PLATFORM" =~ ^(win|win-x64|windows)$ ]]; } && [ "$(uname -s)" = "Linux" ]; then
    ensure_wine_installed || true
  fi

  if $BUILD_ALL; then
    info "Building for all platforms"
    npm run dist:linux 2>&1 | tail -20
    if command -v wine64 >/dev/null 2>&1 || command -v wine >/dev/null 2>&1; then
      npm run dist:win 2>&1 | tail -20
    else
      warn "Skipping Windows build — Wine not available"
    fi
  else
    case "$PLATFORM" in
      win|win-x64|windows)
        info "Building Windows NSIS installer"
        npm run dist:win 2>&1 | tail -20
        ;;
      linux|linux-x64)
        info "Building Linux AppImage"
        npm run dist:linux 2>&1 | tail -20
        ;;
      mac|mac-x64|mac-arm64|darwin)
        info "Building macOS DMG"
        npm run dist:mac 2>&1 | tail -20
        ;;
      *)
        fail "Unknown platform: ${PLATFORM}. Use: win, linux, mac, or --all"
        ;;
    esac
  fi

  ok "Build complete"
fi

# ── Upload to MinIO via tools-service ─────────────────────────
if $DRY_RUN; then
  step "Dry run — skipping upload"
  info "Built artifacts in ${DIST_DIR}:"
  ls -lh "${DIST_DIR}" 2>/dev/null | grep -E '\.(exe|dmg|AppImage)$' || warn "No installer files found"
  exit 0
fi

step "Uploading installers to MinIO"

upload_file() {
  local file_path="$1"
  local platform_key="$2"
  local file_name
  file_name=$(basename "$file_path")

  if [ ! -f "$file_path" ]; then
    warn "File not found: ${file_path} — skipping"
    return 1
  fi

  local file_size_bytes
  file_size_bytes=$(stat -c%s "$file_path" 2>/dev/null || stat -f%z "$file_path" 2>/dev/null || echo "0")
  local file_size_megabytes=$(echo "scale=1; ${file_size_bytes} / 1048576" | bc 2>/dev/null || echo "?")

  info "Uploading ${file_name} (${file_size_megabytes} MB) as ${platform_key}..."

  # Authenticate the upload when a secret is available — an unauthenticated
  # PUT here would let anyone replace the installers users download.
  local auth_args=()
  if [ -n "${WORKSPACE_SERVICE_SECRET:-}" ]; then
    auth_args=(-H "x-api-secret: ${WORKSPACE_SERVICE_SECRET}")
  else
    warn "WORKSPACE_SERVICE_SECRET not set — uploading without auth header"
  fi

  local http_status
  http_status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT \
    -H "Content-Type: application/octet-stream" \
    "${auth_args[@]}" \
    --data-binary "@${file_path}" \
    --max-time 300 \
    "${TOOLS_API_URL}/agents/upload/tray-app?platform=${platform_key}")

  if [ "$http_status" = "200" ]; then
    ok "Uploaded ${file_name} → ${platform_key}"
    return 0
  else
    warn "Upload failed for ${file_name} (HTTP ${http_status})"
    return 1
  fi
}

UPLOADED=0
FAILED=0

# Windows installer
WINDOWS_INSTALLER=$(find "${DIST_DIR}" -maxdepth 1 -name "*.exe" -type f 2>/dev/null | head -1)
if [ -n "$WINDOWS_INSTALLER" ]; then
  upload_file "$WINDOWS_INSTALLER" "win-x64" && UPLOADED=$((UPLOADED + 1)) || FAILED=$((FAILED + 1))
fi

# macOS DMGs
MAC_X64_DMG=$(find "${DIST_DIR}" -maxdepth 1 -name "*-x64.dmg" -type f 2>/dev/null | head -1)
MAC_ARM64_DMG=$(find "${DIST_DIR}" -maxdepth 1 -name "*-arm64.dmg" -type f 2>/dev/null | head -1)
MAC_UNIVERSAL_DMG=$(find "${DIST_DIR}" -maxdepth 1 -name "*.dmg" -not -name "*-x64*" -not -name "*-arm64*" -type f 2>/dev/null | head -1)

if [ -n "$MAC_X64_DMG" ]; then
  upload_file "$MAC_X64_DMG" "mac-x64" && UPLOADED=$((UPLOADED + 1)) || FAILED=$((FAILED + 1))
fi
if [ -n "$MAC_ARM64_DMG" ]; then
  upload_file "$MAC_ARM64_DMG" "mac-arm64" && UPLOADED=$((UPLOADED + 1)) || FAILED=$((FAILED + 1))
fi
if [ -n "$MAC_UNIVERSAL_DMG" ] && [ -z "$MAC_X64_DMG" ]; then
  upload_file "$MAC_UNIVERSAL_DMG" "mac-x64" && UPLOADED=$((UPLOADED + 1)) || FAILED=$((FAILED + 1))
fi

# Linux AppImage
LINUX_APPIMAGE=$(find "${DIST_DIR}" -maxdepth 1 -name "*.AppImage" -type f 2>/dev/null | head -1)
if [ -n "$LINUX_APPIMAGE" ]; then
  upload_file "$LINUX_APPIMAGE" "linux-x64" && UPLOADED=$((UPLOADED + 1)) || FAILED=$((FAILED + 1))
fi

# ── Summary ───────────────────────────────────────────────────
echo ""
if [ "$UPLOADED" -gt 0 ]; then
  ok "Uploaded ${UPLOADED} installer(s) to MinIO"
fi
if [ "$FAILED" -gt 0 ]; then
  warn "${FAILED} upload(s) failed"
fi
if [ "$UPLOADED" -eq 0 ] && [ "$FAILED" -eq 0 ]; then
  warn "No installer files found in ${DIST_DIR}"
  info "Expected: .exe (Windows), .dmg (macOS), .AppImage (Linux)"
fi
