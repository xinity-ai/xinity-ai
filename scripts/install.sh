#!/usr/bin/env bash
# Xinity CLI installer
#
# Usage:
#   curl -fsSL https://github.com/xinity-ai/xinity-ai/releases/latest/download/install.sh | bash
#   curl -fsSL ... | bash -s -- --version v1.0.0 --prefix /usr/local/bin
#
# For private repos, set GITHUB_TOKEN or authenticate with `gh auth login`.
# Private repo downloads require `jq` to be installed.

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────

INSTALL_DIR="${HOME}/.local/bin"
VERSION="latest"
REPO="xinity-ai/xinity-ai"

# ── Colors ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

info()  { printf "  ${CYAN}info${NC}  %s\n" "$1"; }
pass()  { printf "  ${GREEN}  ok${NC}  %s\n" "$1"; }
fail()  { printf "  ${RED}fail${NC}  %s\n" "$1" >&2; exit 1; }
warn()  { printf "  ${YELLOW}warn${NC}  %s\n" "$1"; }

# ── Argument parsing ─────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: install.sh [OPTIONS]

Options:
  --version VERSION   Version to install (tag name or 'latest', default: latest)
  --prefix DIR        Install directory (default: ~/.local/bin)
  --repo OWNER/REPO   GitHub repository (default: xinity-ai/xinity-ai)
  -h, --help          Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)  VERSION="$2"; shift 2 ;;
    --prefix)   INSTALL_DIR="$2"; shift 2 ;;
    --repo)     REPO="$2"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *)          fail "Unknown option: $1. Use --help for usage." ;;
  esac
done

# ── Platform detection ───────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux) ;;
  *)     fail "Unsupported OS: $OS (only Linux is supported)" ;;
esac

case "$ARCH" in
  x86_64)   SUFFIX="linux-x64" ;;
  aarch64)  SUFFIX="linux-arm64" ;;
  *)        fail "Unsupported architecture: $ARCH" ;;
esac

ASSET_NAME="xinity-cli-${SUFFIX}.zip"

# ── Auth (for private repos) ────────────────────────────────────────────────

AUTH_HEADER=""
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  AUTH_HEADER="Authorization: Bearer ${GITHUB_TOKEN}"
elif command -v gh &>/dev/null; then
  TOKEN="$(gh auth token 2>/dev/null || true)"
  if [[ -n "$TOKEN" ]]; then
    AUTH_HEADER="Authorization: Bearer ${TOKEN}"
  fi
fi

IS_PRIVATE=false
if [[ -n "$AUTH_HEADER" ]]; then
  IS_PRIVATE=true
fi

curl_auth() {
  if [[ -n "$AUTH_HEADER" ]]; then
    curl -fsSL -H "$AUTH_HEADER" "$@"
  else
    curl -fsSL "$@"
  fi
}

# ── Version resolution ───────────────────────────────────────────────────────

if [[ "$VERSION" = "latest" ]]; then
  info "Fetching latest release…"
  RELEASE_URL="https://api.github.com/repos/${REPO}/releases/latest"
else
  RELEASE_URL="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
fi

RELEASE_JSON="$(curl_auth -H "Accept: application/vnd.github+json" "$RELEASE_URL" 2>/dev/null)" \
  || fail "Could not fetch release. Is the repo private? Set GITHUB_TOKEN or run 'gh auth login'."

TAG="$(printf '%s' "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')"
[[ -n "$TAG" ]] || fail "Could not parse release tag"

info "Installing xinity CLI ${TAG} (${SUFFIX})"

# ── Asset download helper ────────────────────────────────────────────────────
#
# Public repos:  direct browser download URL (no extra tools needed)
# Private repos: API URL with Accept: application/octet-stream (requires jq)

download_asset() {
  local name="$1" dest="$2"

  if [[ "$IS_PRIVATE" = true ]]; then
    command -v jq &>/dev/null \
      || fail "'jq' is required for private repo downloads. Install it: apt install jq"

    local api_url
    api_url="$(printf '%s' "$RELEASE_JSON" | jq -r --arg name "$name" '.assets[] | select(.name == $name) | .url')"
    [[ -n "$api_url" && "$api_url" != "null" ]] \
      || return 1

    curl_auth -H "Accept: application/octet-stream" -o "$dest" "$api_url"
  else
    local url="https://github.com/${REPO}/releases/download/${TAG}/${name}"
    curl_auth -o "$dest" "$url"
  fi
}

# ── Download ─────────────────────────────────────────────────────────────────

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

info "Downloading ${ASSET_NAME}…"
download_asset "$ASSET_NAME" "${TMP_DIR}/${ASSET_NAME}" \
  || fail "Download failed. Asset ${ASSET_NAME} may not exist in release ${TAG}."

# ── Checksum verification ───────────────────────────────────────────────────

if download_asset "SHASUMS256.txt" "${TMP_DIR}/SHASUMS256.txt" 2>/dev/null; then
  EXPECTED="$(grep "$ASSET_NAME" "${TMP_DIR}/SHASUMS256.txt" | awk '{print $1}')"
  if [[ -n "$EXPECTED" ]]; then
    ACTUAL="$(sha256sum "${TMP_DIR}/${ASSET_NAME}" | awk '{print $1}')"
    if [[ "$EXPECTED" = "$ACTUAL" ]]; then
      pass "SHA256 verified"
    else
      fail "SHA256 mismatch: expected ${EXPECTED}, got ${ACTUAL}"
    fi
  else
    warn "Asset not found in SHASUMS256.txt, skipping verification"
  fi
else
  warn "Could not fetch checksums, skipping verification"
fi

# ── Extract and install ─────────────────────────────────────────────────────

command -v unzip &>/dev/null || fail "'unzip' is required but not found"

mkdir -p "$INSTALL_DIR"
unzip -o "${TMP_DIR}/${ASSET_NAME}" -d "${TMP_DIR}/extracted" >/dev/null
mv "${TMP_DIR}/extracted/xinity" "${INSTALL_DIR}/xinity"
chmod +x "${INSTALL_DIR}/xinity"

pass "Installed xinity ${TAG} to ${INSTALL_DIR}/xinity"

# ── PATH check ──────────────────────────────────────────────────────────────

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo ""
  warn "${INSTALL_DIR} is not in your PATH"
  info "Add this to your shell profile (.bashrc, .zshrc, etc.):"
  printf "  ${DIM}export PATH=\"%s:\$PATH\"${NC}\n" "$INSTALL_DIR"
fi

# ── Completion hint ─────────────────────────────────────────────────────────

echo ""
info "To enable shell completion, add to your profile:"
printf "  ${DIM}source <(xinity completion)${NC}\n"
echo ""
printf "  ${CYAN}info${NC}  Run ${CYAN}xinity --help${NC} to get started\n"
