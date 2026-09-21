#!/usr/bin/env bash
set -euo pipefail

# Vulcan convergent installer/repair script.
# It is intentionally safe to run on every launch.  It treats observed state as
# authoritative and repairs only the components that are absent, stale, or broken.

FROM_APP=0
SERVER_ONLY=0
APP_PATH=""
RESOURCES_DIR=""
VERSION="unknown"
GUEST=""
SERVER_SOURCE=""
SERVER_HASH_FILE=""
SERVER_SOURCE_EXPLICIT=0
JSON_MODE=0
RELEASE_TAG="${VULCAN_RELEASE_TAG:-latest}"
APPIMAGE_URL_OVERRIDE="${VULCAN_APPIMAGE_URL:-}"
APPIMAGE_SHA256_OVERRIDE="${VULCAN_APPIMAGE_SHA256:-}"
SOURCE_TARBALL_URL_OVERRIDE="${VULCAN_SOURCE_TARBALL_URL:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-app) FROM_APP=1; shift ;;
    --server-only) SERVER_ONLY=1; shift ;;
    --app-path) APP_PATH="${2:-}"; shift 2 ;;
    --resources) RESOURCES_DIR="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-unknown}"; shift 2 ;;
    --guest) GUEST="${2:-}"; shift 2 ;;
    --server-source) SERVER_SOURCE="${2:-}"; SERVER_SOURCE_EXPLICIT=1; shift 2 ;;
    --release) RELEASE_TAG="${2:-latest}"; shift 2 ;;
    --server-hash-file) SERVER_HASH_FILE="${2:-}"; shift 2 ;;
    --json) JSON_MODE=1; shift ;;
    *) printf 'Vulcan: unknown install argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

say() {
  if [[ "${CLI_PROGRESS_ACTIVE:-0}" -eq 1 ]]; then return 0; fi
  printf 'Vulcan: %s\n' "$*" >&2
}
support() { printf '%s\n' "$*" >&2; }
warn() { printf 'Vulcan warning: %s\n' "$*" >&2; }
fail() {
  local msg="$*"
  printf 'Vulcan install failed: %s\n' "$msg" >&2
  if [[ "$JSON_MODE" -eq 1 ]]; then
    printf 'VULCAN_RESULT={"ok":false,"message":%s}\n' "$(python_json_string "$msg")"
  fi
  exit 1
}
python_json_string() {
  # Minimal JSON string escaping without requiring Python before uv exists.
  local value="${1-}"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '"%s"' "$value"
}
emit_ok() {
  local relaunch="${1:-}"
  local relogin="${2:-0}"
  if [[ "$JSON_MODE" -eq 1 ]]; then
    printf 'VULCAN_RESULT={"ok":true,"relaunchPath":%s,"needsRelogin":%s}\n' \
      "$(python_json_string "$relaunch")" "$([[ "$relogin" == 1 ]] && echo true || echo false)"
  fi
}
have() { command -v "$1" >/dev/null 2>&1; }

PROGRESS_TOTAL=0
PROGRESS_DONE=0
PROGRESS_COMPLETED='|'
PROGRESS_LAST_GROUP=''
CLI_PROGRESS_ACTIVE=0
DOCKER_RELOGIN=0
CLI_LIGHT_GREEN=''
CLI_GREEN=''
CLI_LIGHT_GREY=''
CLI_GREY=''
CLI_LIGHT_BLUE=''
CLI_RESET=''

progress_group_label() {
  case "$1" in
    checking) printf '%s' 'Checking installation' ;;
    python) printf '%s' 'Preparing Python' ;;
    server) printf '%s' 'Installing server' ;;
    etna) printf '%s' 'Checking Etna' ;;
    workspace) printf '%s' 'Preparing workspace' ;;
    services) printf '%s' 'Starting services' ;;
    *) printf '%s' "$1" ;;
  esac
}

progress_is_complete() {
  case "$PROGRESS_COMPLETED" in
    *"|$1|"*) return 0 ;;
    *) return 1 ;;
  esac
}

cli_clear_progress() {
  [[ "$CLI_PROGRESS_ACTIVE" -eq 1 && -t 2 ]] || return 0
  printf '\r\033[2K' >&2
}

cli_render_progress() {
  [[ "$CLI_PROGRESS_ACTIVE" -eq 1 && -t 2 ]] || return 0
  [[ "$PROGRESS_TOTAL" -gt 0 ]] || return 0
  local filled empty pct fill_text='' empty_text=''
  filled=$(( PROGRESS_DONE * 50 / PROGRESS_TOTAL ))
  empty=$(( 50 - filled ))
  pct=$(( PROGRESS_DONE * 100 / PROGRESS_TOTAL ))
  printf -v fill_text '%*s' "$filled" ''
  printf -v empty_text '%*s' "$empty" ''
  fill_text="${fill_text// /█}"
  empty_text="${empty_text// /░}"
  printf '\r\033[2K%s%s%s%s%s (%d/%d) (%d%%)' \
    "$CLI_LIGHT_GREEN" "$fill_text" "$CLI_GREEN" "$empty_text" "$CLI_RESET" \
    "$PROGRESS_DONE" "$PROGRESS_TOTAL" "$pct" >&2
}

cli_section() {
  [[ "$CLI_PROGRESS_ACTIVE" -eq 1 ]] || return 0
  local group="$1"
  [[ "$group" != "$PROGRESS_LAST_GROUP" ]] || return 0
  cli_clear_progress
  printf '%s%s%s\n' "$CLI_GREY" "$(progress_group_label "$group")" "$CLI_RESET" >&2
  PROGRESS_LAST_GROUP="$group"
}

progress_plan() {
  local total="$1" checking="$2" python="$3" server="$4"
  local etna="$5" workspace="$6" services="$7"
  PROGRESS_TOTAL="$total"
  PROGRESS_DONE=0
  PROGRESS_COMPLETED='|'
  PROGRESS_LAST_GROUP=''

  if [[ "$JSON_MODE" -eq 1 ]]; then
    printf 'VULCAN_PROGRESS={"type":"plan","total":%d,"groups":{"checking":%d,"python":%d,"server":%d,"etna":%d,"workspace":%d,"services":%d}}\n' \
      "$total" "$checking" "$python" "$server" "$etna" "$workspace" "$services" >&2
    return
  fi

  if [[ "$SERVER_ONLY" -eq 1 && -z "$GUEST" ]]; then
    CLI_PROGRESS_ACTIVE=1
    if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
      CLI_LIGHT_GREEN=$'\033[92m'
      CLI_GREEN=$'\033[32m'
      CLI_LIGHT_GREY=$'\033[37m'
      CLI_GREY=$'\033[90m'
      CLI_LIGHT_BLUE=$'\033[94m'
      CLI_RESET=$'\033[0m'
    fi
    cli_render_progress
  fi
}

progress_task_start() {
  local group="$1" id="$2" label="$3"
  local key="$group:$id"
  [[ "$PROGRESS_TOTAL" -gt 0 ]] || return 0
  progress_is_complete "$key" && return 0

  if [[ "$JSON_MODE" -eq 1 ]]; then
    printf 'VULCAN_PROGRESS={"type":"task","group":%s,"id":%s,"state":"running","label":%s}\n' \
      "$(python_json_string "$group")" "$(python_json_string "$id")" "$(python_json_string "$label")" >&2
    return
  fi

  if [[ "$CLI_PROGRESS_ACTIVE" -eq 1 ]]; then
    cli_section "$group"
    cli_render_progress
  fi
}

progress_task_finish() {
  local group="$1" id="$2" state="$3" label="$4"
  local key="$group:$id"
  [[ "$PROGRESS_TOTAL" -gt 0 ]] || return 0
  progress_is_complete "$key" && return 0
  PROGRESS_COMPLETED="${PROGRESS_COMPLETED}${key}|"
  PROGRESS_DONE=$(( PROGRESS_DONE + 1 ))

  if [[ "$JSON_MODE" -eq 1 ]]; then
    printf 'VULCAN_PROGRESS={"type":"task","group":%s,"id":%s,"state":%s,"label":%s}\n' \
      "$(python_json_string "$group")" "$(python_json_string "$id")" \
      "$(python_json_string "$state")" "$(python_json_string "$label")" >&2
    return
  fi

  if [[ "$CLI_PROGRESS_ACTIVE" -eq 1 ]]; then
    cli_section "$group"
    cli_clear_progress
    if [[ "$state" == skipped ]]; then
      printf '  %s·%s  %s\n' "$CLI_LIGHT_GREY" "$CLI_RESET" "$label" >&2
    else
      printf '  %s✔%s  %s\n' "$CLI_LIGHT_GREEN" "$CLI_RESET" "$label" >&2
    fi
    cli_render_progress
  fi
}

progress_conclusion() {
  [[ "$CLI_PROGRESS_ACTIVE" -eq 1 ]] || return 0
  cli_clear_progress
  printf '%s[Vulcan]%s %s✔%s  %s\n' \
    "$CLI_LIGHT_BLUE" "$CLI_RESET" "$CLI_LIGHT_GREEN" "$CLI_RESET" "$1" >&2
}

run_privileged() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  elif [[ "$SERVER_ONLY" -eq 1 ]] && have sudo; then
    sudo "$@"
  elif have pkexec; then
    pkexec "$@"
  elif have sudo; then
    sudo "$@"
  else
    fail "administrator privileges are required, but neither pkexec nor sudo is available"
  fi
}

OS="$(uname -s)"
VULCAN_HOME="${VULCAN_CONFIG_DIR:-$HOME/.vulcan}"
APP_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/vulcan"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
BIN_HOME="$VULCAN_HOME/bin"
PYTHON_HOME="$VULCAN_HOME/python"
RUNTIME="$VULCAN_HOME/runtime"
PAYLOAD_HOME="$VULCAN_HOME/payload"
SERVER_INSTALLED_HASH="$PAYLOAD_HOME/server-payload.sha256"
mkdir -p "$VULCAN_HOME" "$BIN_HOME" "$PYTHON_HOME" "$PAYLOAD_HOME"

export UV_PYTHON_INSTALL_DIR="$PYTHON_HOME"
HOST_PATH="${PATH:-/usr/bin:/bin}"
export PATH="$BIN_HOME:$HOST_PATH"

# Resolve packaged payload paths when launched from Electron.
if [[ -z "$SERVER_SOURCE" && -n "$RESOURCES_DIR" && -d "$RESOURCES_DIR/vulcan-server" ]]; then
  SERVER_SOURCE="$RESOURCES_DIR/vulcan-server"
fi
if [[ -z "$SERVER_HASH_FILE" && -n "$RESOURCES_DIR" && -f "$RESOURCES_DIR/server-payload.sha256" ]]; then
  SERVER_HASH_FILE="$RESOURCES_DIR/server-payload.sha256"
fi

ensure_downloader() {
  if have curl || have wget; then return 0; fi
  fail "curl or wget is required to bootstrap uv"
}
download_stdout() {
  local url="$1"
  if have curl; then curl -LsSf --retry 3 "$url"; else wget -qO- "$url"; fi
}
download_file() {
  local url="$1" dest="$2"
  if have curl; then
    curl -LfsS --retry 3 --retry-delay 1 "$url" -o "$dest"
  else
    wget -qO "$dest" "$url"
  fi
}
verify_sha256() {
  local file="$1" expected="${2,,}" actual
  expected="${expected#sha256:}"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail "Expected SHA-256 is malformed"

  if have sha256sum; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif have shasum; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  elif have openssl; then
    actual="$(openssl dgst -sha256 "$file" | awk '{print $NF}')"
  else
    fail "sha256sum, shasum, or openssl is required to verify downloaded Vulcan artifacts"
  fi

  [[ "${actual,,}" == "$expected" ]] \
    || fail "Downloaded Vulcan artifact checksum verification failed"
}

release_api_url() {
  if [[ "$RELEASE_TAG" == "latest" ]]; then
    printf '%s' 'https://api.github.com/repos/dwhite-sys/vulcan/releases/latest'
  else
    printf 'https://api.github.com/repos/dwhite-sys/vulcan/releases/tags/%s' "$RELEASE_TAG"
  fi
}

release_metadata() {
  local metadata
  metadata="$(download_stdout "$(release_api_url)")" \
    || fail "Could not read Vulcan release metadata for $RELEASE_TAG"
  printf '%s\n' "$metadata"
}

resolve_release_tag() {
  if [[ "$RELEASE_TAG" != "latest" ]]; then
    printf '%s' "$RELEASE_TAG"
    return
  fi

  local metadata line
  metadata="$(release_metadata)"

  while IFS= read -r line; do
    if [[ "$line" =~ \"tag_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
      printf '%s' "${BASH_REMATCH[1]}"
      return
    fi
  done <<< "$metadata"

  fail "GitHub release metadata did not contain a release tag"
}

release_asset_digest() {
  local asset="$1" metadata compact asset_record digest_tail digest body body_tail
  metadata="$(release_metadata)"

  compact="$(printf '%s' "$metadata" | tr -d '\r\n\t ')"

  # Prefer GitHub's per-asset digest when present.
  asset_record="${compact#*\"name\":\"$asset\"}"

  if [[ "$asset_record" != "$compact" ]]; then
    asset_record="${asset_record%%\"browser_download_url\":*}"
    digest_tail="${asset_record#*\"digest\":\"sha256:}"

    if [[ "$digest_tail" != "$asset_record" ]]; then
      digest="${digest_tail%%\"*}"

      if [[ "$digest" =~ ^[0-9A-Fa-f]{64}$ ]]; then
        printf '%s' "${digest,,}"
        return
      fi
    fi
  fi

  # Some GitHub API responses omit asset.digest. Every Vulcan release also
  # publishes the hashes in its generated release body, so use that as the
  # authoritative fallback.
  body="${compact#*\"body\":\"###SHA-256}"

  if [[ "$body" != "$compact" ]]; then
    body="${body//\`/}"
    body_tail="${body#*|$asset|}"

    if [[ "$body_tail" != "$body" ]]; then
      digest="${body_tail%%|*}"

      if [[ "$digest" =~ ^[0-9A-Fa-f]{64}$ ]]; then
        printf '%s' "${digest,,}"
        return
      fi
    fi
  fi

  fail "GitHub release metadata did not contain a SHA-256 digest for $asset"
}

release_asset_url() {
  local asset="$1"
  if [[ "$RELEASE_TAG" == "latest" ]]; then
    printf 'https://github.com/dwhite-sys/vulcan/releases/latest/download/%s' "$asset"
  else
    printf 'https://github.com/dwhite-sys/vulcan/releases/download/%s/%s' "$RELEASE_TAG" "$asset"
  fi
}

standalone_server_bootstrap() {
  [[ "$OS" == "Linux" ]] \
    || fail "--server-only network bootstrap currently supports native Linux"

  ensure_downloader
  have tar || fail "tar is required for --server-only"

  local resolved_tag source_url tmp_source extract_root source_root
  local packaged_installer result

  resolved_tag="$(resolve_release_tag)"
  source_url="${SOURCE_TARBALL_URL_OVERRIDE:-https://api.github.com/repos/dwhite-sys/vulcan/tarball/$resolved_tag}"

  tmp_source="$(mktemp "${TMPDIR:-/tmp}/vulcan-source.XXXXXX.tar.gz")"
  extract_root="$(mktemp -d "${TMPDIR:-/tmp}/vulcan-source-extract.XXXXXX")"

  trap 'rm -f "${tmp_source:-}"; rm -rf "${extract_root:-}"' EXIT

  support "Downloading Vulcan source for ${resolved_tag}..."
  download_file "$source_url" "$tmp_source" \
    || fail "Could not download Vulcan source archive from $source_url"

  tar -xzf "$tmp_source" -C "$extract_root" \
    || fail "Could not extract the Vulcan source archive"

  source_root="$(
    find "$extract_root" -mindepth 1 -maxdepth 1 -type d -print -quit
  )"

  [[ -n "$source_root" ]] \
    || fail "Vulcan source archive did not contain a repository root"

  packaged_installer="$source_root/install.sh"

  [[ -f "$packaged_installer" ]] \
    || fail "Vulcan source archive does not contain install.sh"

  [[ -f "$source_root/vulcan/pyproject.toml" ]] \
    || fail "Vulcan source archive does not contain the server package"

  # Match the packaged server payload: tests and repository-only backlog material
  # are useful in source archives but need not become persistent runtime payload.
  rm -rf "$source_root/vulcan/tests"
  rm -f "$source_root/vulcan/SERVER_MANAGEMENT_UI_BACKLOG.md"

  support "Converging headless Vulcan server..."

  local cmd=(
    /bin/bash "$packaged_installer"
    --server-only
    --server-source "$source_root/vulcan"
    --version "${resolved_tag#v}"
  )

  [[ "$JSON_MODE" -eq 1 ]] && cmd+=(--json)

  if "${cmd[@]}"; then
    result=0
  else
    result=$?
  fi

  [[ "$result" -eq 0 ]] || exit "$result"

  rm -f "$tmp_source"
  rm -rf "$extract_root"
  trap - EXIT

  : # converger emitted the final result line
}

standalone_linux_bootstrap() {
  ensure_downloader

  local installed="$APP_DATA_HOME/app/Vulcan.AppImage"
  local tmp_app expected_sha

  mkdir -p "$(dirname "$installed")"
  tmp_app="$(mktemp "${TMPDIR:-/tmp}/vulcan-appimage.XXXXXX")"
  trap 'rm -f "${tmp_app:-}"' EXIT

  say "Downloading Vulcan"
  download_file "$(release_asset_url Vulcan.AppImage)" "$tmp_app" \
    || fail "Could not download Vulcan.AppImage"

  expected_sha="$(release_asset_digest Vulcan.AppImage)"
  verify_sha256 "$tmp_app" "$expected_sha"

  chmod 0755 "$tmp_app"
  mv -f "$tmp_app" "$installed"
  trap - EXIT

  say "Launching Vulcan"
  nohup "$installed" >/dev/null 2>&1 &
}

standalone_macos_bootstrap() {
  ensure_downloader

  have hdiutil || fail "hdiutil is required on macOS"
  have ditto || fail "ditto is required on macOS"
  have open || fail "open is required on macOS"

  local tmp_dmg mount_dir source_app target_app expected_sha

  tmp_dmg="$(mktemp "${TMPDIR:-/tmp}/vulcan-dmg.XXXXXX")"
  mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/vulcan-dmg-mount.XXXXXX")"

  trap 'hdiutil detach "${mount_dir:-}" >/dev/null 2>&1 || true; rm -f "${tmp_dmg:-}"; rm -rf "${mount_dir:-}"' EXIT

  say "Downloading Vulcan"
  download_file "$(release_asset_url Vulcan.dmg)" "$tmp_dmg" \
    || fail "Could not download Vulcan.dmg"

  expected_sha="$(release_asset_digest Vulcan.dmg)"
  verify_sha256 "$tmp_dmg" "$expected_sha"

  hdiutil attach \
    -nobrowse \
    -readonly \
    -mountpoint "$mount_dir" \
    "$tmp_dmg" >/dev/null

  source_app="$(find "$mount_dir" -maxdepth 2 -type d -name 'Vulcan.app' -print -quit)"
  [[ -n "$source_app" ]] || fail "Vulcan.app was not found in the DMG"

  mkdir -p "$HOME/Applications"
  target_app="$HOME/Applications/Vulcan.app"

  rm -rf "$target_app.new"
  ditto "$source_app" "$target_app.new"
  rm -rf "$target_app"
  mv "$target_app.new" "$target_app"

  hdiutil detach "$mount_dir" >/dev/null
  rm -f "$tmp_dmg"
  rm -rf "$mount_dir"
  trap - EXIT

  say "Launching Vulcan"
  open "$target_app"
}

ensure_uv() {
  progress_task_start python uv "Checking uv runtime"
  if [[ -x "$BIN_HOME/uv" ]] && "$BIN_HOME/uv" --version >/dev/null 2>&1; then
    progress_task_finish python uv skipped "uv runtime already ready"
    return
  fi
  say "Repairing uv runtime"
  ensure_downloader
  download_stdout https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL="$BIN_HOME" sh >/dev/null
  [[ -x "$BIN_HOME/uv" ]] || fail "uv installer completed without creating $BIN_HOME/uv"
  progress_task_finish python uv done "uv runtime ready"
}

ensure_python() {
  ensure_uv
  progress_task_start python python312 "Checking managed Python 3.12"
  if "$BIN_HOME/uv" python find --managed-python 3.12 >/dev/null 2>&1; then
    progress_task_finish python python312 skipped "Python 3.12 already ready"
    return
  fi
  say "Installing Vulcan-managed Python 3.12"
  "$BIN_HOME/uv" python install 3.12 >/dev/null
  progress_task_finish python python312 done "Python 3.12 ready"
}

etna_endpoint_healthy() {
  local body=""

  if have curl; then
    body="$(curl -fsS --max-time 2 http://127.0.0.1:8467/health 2>/dev/null || true)"
  elif have wget; then
    body="$(wget -qO- --timeout=2 http://127.0.0.1:8467/health 2>/dev/null || true)"
  else
    return 1
  fi

  body="$(printf '%s' "$body" | tr -d '[:space:]')"

  [[ "$body" == *'"service":"etna-mcp"'* \
    && "$body" == *'"status":"ok"'* ]]
}

etna_kit_ready() {
  local kit="$1"
  local config="$HOME/.etna_server/config.json"

  [[ -f "$config" ]] || return 1
  [[ -f "$HOME/.etna_server/kits/$kit.py" ]] || return 1

  grep -Eq "\"$kit\"[[:space:]]*:" "$config"
}

run_etna() {
  local etna py name

  etna="$(PATH="$HOST_PATH:$HOME/.local/bin" command -v etna 2>/dev/null || true)"

  if [[ -n "$etna" && -x "$etna" ]] && "$etna" "$@"; then
    return
  fi

  for name in python3 python; do
    py="$(PATH="$HOST_PATH" command -v "$name" 2>/dev/null || true)"
    [[ -n "$py" ]] || continue

    if "$py" -m etna "$@"; then
      return
    fi
  done

  return 1
}

install_host_etna() {
  local installer

  installer="$(PATH="$HOST_PATH" command -v pip 2>/dev/null || true)"
  if [[ -n "$installer" ]] \
    && "$installer" install 'etna-mcp>=1.0.0b41' >/dev/null 2>&1 \
    && run_etna --help >/dev/null 2>&1
  then
    return
  fi

  installer="$(PATH="$HOST_PATH:$HOME/.local/bin" command -v pipx 2>/dev/null || true)"
  if [[ -n "$installer" ]] \
    && "$installer" install 'etna-mcp>=1.0.0b41' >/dev/null 2>&1 \
    && run_etna --help >/dev/null 2>&1
  then
    return
  fi

  env \
    -u UV_PYTHON_INSTALL_DIR \
    -u UV_TOOL_DIR \
    -u UV_TOOL_BIN_DIR \
    PATH="$HOST_PATH:$HOME/.local/bin" \
    "$BIN_HOME/uv" tool install --force 'etna-mcp>=1.0.0b41' >/dev/null 2>&1 \
    && run_etna --help >/dev/null 2>&1
}

ensure_etna() {
  local kit

  ensure_python

  # Remove the obsolete Vulcan-owned Etna installation.
  rm -f "$BIN_HOME/etna"
  rm -rf "$VULCAN_HOME/uv-tools/etna-mcp"
  rmdir "$VULCAN_HOME/uv-tools" >/dev/null 2>&1 || true

  progress_task_start etna cli "Checking Etna CLI"

  if run_etna --help >/dev/null 2>&1; then
    progress_task_finish etna cli skipped "Host Etna already installed"
  else
    say "Installing Etna"
    install_host_etna \
      || fail "Could not install Etna with pip, pipx, or uv"
    progress_task_finish etna cli done "Host Etna installed"
  fi

  progress_task_start etna runtime "Checking Etna runtime"

  if etna_endpoint_healthy; then
    progress_task_finish etna runtime skipped "Etna runtime already healthy"
  else
    if ! run_etna init >/dev/null 2>&1; then
      say "Repairing Etna installation"
      install_host_etna \
        || fail "Could not repair Etna"
      run_etna init >/dev/null 2>&1 \
        || fail "Etna init failed"
    fi

    etna_endpoint_healthy \
      || fail "Etna init completed but Etna is not healthy on port 8467"

    progress_task_finish etna runtime done "Etna runtime repaired"
  fi

  for kit in web playwright ntfy; do
    progress_task_start etna "kit-$kit" "Checking Etna kit: $kit"

    if etna_kit_ready "$kit"; then
      progress_task_finish etna "kit-$kit" skipped "Etna kit already ready: $kit"
    else
      run_etna install "$kit" >/dev/null 2>&1 \
        || fail "Could not install Etna kit: $kit"
      progress_task_finish etna "kit-$kit" done "Etna kit ready: $kit"
    fi
  done

  progress_task_start etna endpoint "Checking Etna endpoint"

  etna_endpoint_healthy \
    || fail "Etna is not healthy on port 8467"

  progress_task_finish etna endpoint skipped "Etna endpoint healthy"
}

server_payload_hash() {
  if [[ -n "$SERVER_HASH_FILE" && -f "$SERVER_HASH_FILE" ]]; then
    tr -d '[:space:]' < "$SERVER_HASH_FILE"
    return
  fi
  # Development/manual fallback: stable hash of server source contents.
  if [[ -n "$SERVER_SOURCE" && -d "$SERVER_SOURCE" ]]; then
    if have sha256sum; then
      find "$SERVER_SOURCE" -type f ! -path '*/tests/*' ! -path '*/__pycache__/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'
    elif have shasum; then
      find "$SERVER_SOURCE" -type f ! -path '*/tests/*' ! -path '*/__pycache__/*' -print | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | awk '{print $1}'
    else
      printf '%s' "$VERSION"
    fi
    return
  fi
  printf '%s' "$VERSION"
}

ensure_vulcan_runtime() {
  ensure_python
  [[ -n "$SERVER_SOURCE" && -d "$SERVER_SOURCE" ]] || fail "Vulcan server payload is missing"

  local wanted current="" py="$RUNTIME/bin/python"
  local installed_source="$PAYLOAD_HOME/server"

  wanted="$(server_payload_hash)"
  [[ -f "$SERVER_INSTALLED_HASH" ]] && current="$(tr -d '[:space:]' < "$SERVER_INSTALLED_HASH")"

  local healthy=0 payload_ready=0
  if [[ -x "$py" ]] && "$py" -c 'import vulcan, fastapi, uvicorn, cryptography, numpy, sklearn, fastembed, spacy, PIL' >/dev/null 2>&1; then
    healthy=1
  fi
  [[ -f "$installed_source/pyproject.toml" ]] && payload_ready=1

  if [[ "$current" == "$wanted" && "$healthy" -eq 1 && "$payload_ready" -eq 1 ]]; then
    progress_task_finish server payload skipped "Server payload already current"
    progress_task_finish server runtime skipped "Server runtime already healthy"
    return
  fi

  say "Repairing Vulcan server runtime"

  # Packaged resources are delivery media, not Vulcan's persistent home.
  # Persist the server payload under ~/.vulcan before setuptools/uv builds it.
  local source_real installed_real="" staged_source
  source_real="$(cd "$SERVER_SOURCE" && pwd -P)"

  if [[ -d "$installed_source" ]]; then
    installed_real="$(cd "$installed_source" && pwd -P)"
  fi

  progress_task_start server payload "Synchronizing server payload"
  if [[ "$source_real" != "$installed_real" ]]; then
    staged_source="$PAYLOAD_HOME/.server.$$"
    rm -rf "$staged_source"
    mkdir -p "$staged_source"

    if ! cp -R "$SERVER_SOURCE"/. "$staged_source"/; then
      rm -rf "$staged_source"
      fail "Could not persist Vulcan server payload under $VULCAN_HOME"
    fi

    rm -rf "$installed_source"
    mv "$staged_source" "$installed_source"
    progress_task_finish server payload done "Server payload synchronized"
  else
    progress_task_finish server payload skipped "Server payload already staged"
  fi

  progress_task_start server runtime "Installing Vulcan server runtime"
  if [[ -n "$GUEST" || "$SERVER_ONLY" -eq 1 ]]; then
    run_privileged systemctl stop vulcan.service >/dev/null 2>&1 || true
  else
    systemctl --user stop vulcan.service >/dev/null 2>&1 || true
  fi

  rm -rf "$RUNTIME"
  "$BIN_HOME/uv" venv --python 3.12 "$RUNTIME" >/dev/null

  if ! "$BIN_HOME/uv" pip install --python "$RUNTIME/bin/python" "$installed_source" >/dev/null; then
    fail "Could not install Vulcan server runtime"
  fi

  printf '%s\n' "$wanted" > "$SERVER_INSTALLED_HASH"
  progress_task_finish server runtime done "Vulcan server runtime ready"
}

install_docker_linux_host() {
  if have docker; then return; fi
  [[ -r /etc/os-release ]] || fail "Docker is missing and Linux distribution could not be identified"
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" == arch || " ${ID_LIKE:-} " == *" arch "* ]]; then
    say "Installing Docker Engine (Arch)"
    run_privileged /usr/bin/pacman -S --needed --noconfirm docker
  else
    ensure_downloader
    local tmp
    tmp="$(mktemp)"
    download_stdout https://get.docker.com > "$tmp"
    say "Installing Docker Engine"
    run_privileged /bin/sh "$tmp"
    rm -f "$tmp"
  fi
}

ensure_docker_linux() {
  DOCKER_RELOGIN=0
  local changed=0
  progress_task_start workspace docker "Checking Docker"
  if [[ -z "$GUEST" ]] && ! have docker; then
    install_docker_linux_host
    changed=1
  fi
  have docker || fail "Docker Engine is not available"

  if ! docker info >/dev/null 2>&1; then
    changed=1
    if [[ -z "$GUEST" ]]; then
      if have systemctl; then run_privileged systemctl enable --now docker.service >/dev/null || true; fi

      # `id -nG "$USER"` reflects durable group-database membership; bare
      # `id -nG` reflects this process's current supplementary groups.
      local durable=0 current=0
      id -nG "$USER" | tr ' ' '\n' | grep -qx docker && durable=1 || true
      id -nG | tr ' ' '\n' | grep -qx docker && current=1 || true
      if [[ "$durable" -eq 0 ]]; then
        run_privileged usermod -aG docker "$USER"
        durable=1
      fi
      # A normal desktop process needs one fresh login session to inherit the new
      # supplementary group. A headless systemd service is a new process and gets
      # the durable group membership immediately, so --server-only can continue.
      if [[ "$durable" -eq 1 && "$current" -eq 0 && "$SERVER_ONLY" -eq 0 ]]; then DOCKER_RELOGIN=1; fi
    else
      # WSL/Colima guest provisioning is expected to have configured Docker.
      if have sudo; then sudo systemctl enable --now docker.service >/dev/null 2>&1 || true; fi
      docker info >/dev/null 2>&1 || fail "Docker Engine is installed in the Vulcan guest but is not usable"
    fi
  fi
  if [[ "$changed" -eq 1 ]]; then
    progress_task_finish workspace docker done "Docker ready"
  else
    progress_task_finish workspace docker skipped "Docker already ready"
  fi
}

ensure_vulcan_service_linux() {
  local py="$RUNTIME/bin/python"
  if [[ -n "$GUEST" || "$SERVER_ONLY" -eq 1 ]]; then
    # Dedicated VM/distro and native --server-only installs use a system service
    # so the backend survives logout and starts at boot without a desktop session.
    local unit tmp_unit
    unit="[Unit]\nDescription=Vulcan Server\nAfter=network-online.target docker.service\nWants=network-online.target\n\n[Service]\nType=simple\nUser=$USER\nEnvironment=HOME=$HOME\nEnvironment=PATH=$BIN_HOME:/usr/local/bin:/usr/bin:/bin\nEnvironment=PYTHONUNBUFFERED=1\nExecStart=$RUNTIME/bin/vulcan serve\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=multi-user.target\n"
    tmp_unit="$(mktemp)"
    printf '%b' "$unit" > "$tmp_unit"
    run_privileged install -m 0644 "$tmp_unit" /etc/systemd/system/vulcan.service
    rm -f "$tmp_unit"
    run_privileged systemctl daemon-reload
    run_privileged systemctl enable --now vulcan.service >/dev/null
  else
    local dir="$CONFIG_HOME/systemd/user" file="$CONFIG_HOME/systemd/user/vulcan.service"
    mkdir -p "$dir"
    cat > "$file" <<UNIT
[Unit]
Description=Vulcan Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=$HOME
Environment=PATH=$BIN_HOME:/usr/local/bin:/usr/bin:/bin
Environment=PYTHONUNBUFFERED=1
ExecStart=$RUNTIME/bin/vulcan serve
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now vulcan.service >/dev/null
  fi
}

wait_server() {
  local py="$RUNTIME/bin/python"
  for _ in $(seq 1 60); do
    if "$py" - <<'PY' >/dev/null 2>&1
import urllib.request
urllib.request.urlopen('http://127.0.0.1:8468/meta', timeout=.6).read()
PY
    then return 0; fi
    sleep .25
  done
  return 1
}

install_linux_desktop() {
  [[ "$SERVER_ONLY" -eq 0 ]] || return 0
  [[ "$FROM_APP" -eq 1 ]] || return 0
  local app_home="$APP_DATA_HOME/app"
  local desktop_home="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  local icon_home="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
  local autostart_home="$CONFIG_HOME/autostart"
  mkdir -p "$app_home" "$desktop_home" "$icon_home" "$autostart_home"

  local installed="$app_home/Vulcan.AppImage"
  if [[ -n "$APP_PATH" && -f "$APP_PATH" ]]; then
    if [[ "$(readlink -f "$APP_PATH")" != "$(readlink -f "$installed" 2>/dev/null || true)" ]]; then
      local tmp="$installed.new"
      cp -f "$APP_PATH" "$tmp"
      chmod 0755 "$tmp"
      mv -f "$tmp" "$installed"
    fi
  fi
  [[ -x "$installed" ]] || fail "Could not establish installed AppImage at $installed"

  if [[ -n "$RESOURCES_DIR" && -f "$RESOURCES_DIR/vulcan-icon.png" ]]; then
    cp -f "$RESOURCES_DIR/vulcan-icon.png" "$icon_home/vulcan.png"
  fi
  cat > "$desktop_home/vulcan.desktop" <<DESKTOP
[Desktop Entry]
Name=Vulcan
Comment=AI harness with local server and workspaces
Exec="$installed"
TryExec=$installed
Icon=vulcan
Terminal=false
Type=Application
Categories=Development;Utility;
StartupWMClass=Vulcan
X-AppImage-Integrate=false
DESKTOP
  cat > "$autostart_home/vulcan.desktop" <<DESKTOP
[Desktop Entry]
Name=Vulcan
Comment=Start Vulcan in the system tray
Exec="$installed" --hidden
TryExec=$installed
Icon=vulcan
Terminal=false
Type=Application
X-GNOME-Autostart-enabled=true
X-KDE-autostart-after=panel
X-AppImage-Integrate=false
DESKTOP
  chmod +x "$desktop_home/vulcan.desktop" "$autostart_home/vulcan.desktop"
  have update-desktop-database && update-desktop-database "$desktop_home" >/dev/null 2>&1 || true
  printf '%s' "$installed"
}

linux_converge() {
  local relogin=0
  progress_plan 15 1 2 2 6 2 2

  # Persist/update the stable AppImage and desktop metadata for future launches,
  # but keep the Electron process the user actually opened as this first session.
  progress_task_start checking integration "Checking installation"
  if [[ -z "$GUEST" && "$SERVER_ONLY" -eq 0 ]]; then
    install_linux_desktop >/dev/null
    progress_task_finish checking integration done "Desktop integration ready"
  else
    progress_task_finish checking integration skipped "Desktop integration not required"
  fi
  ensure_vulcan_runtime
  # Etna is deliberately host-side. On native headless Linux, the host is also
  # the server machine, so the same Etna + kit runtime is retained.
  if [[ -z "$GUEST" ]]; then ensure_etna; fi
  if [[ -z "$GUEST" && "$SERVER_ONLY" -eq 1 ]] && have loginctl; then
    # Etna is a systemd user service. Linger keeps that user manager available
    # after SSH logout while Vulcan itself is supervised by a system service.
    run_privileged loginctl enable-linger "$USER" >/dev/null 2>&1 || true
    systemctl --user enable --now etna.service >/dev/null 2>&1 || true
  fi
  ensure_docker_linux
  relogin="$DOCKER_RELOGIN"
  # Build/repair the workspace image whenever Docker is usable. A headless install
  # can immediately adopt newly-added docker-group membership via `sg` instead of
  # forcing an SSH logout/login cycle.
  progress_task_start workspace image "Preparing Docker workspace image"
  if docker info >/dev/null 2>&1; then
    say "Preparing Docker workspace image"
    "$RUNTIME/bin/vulcan" install --runtime-only >/dev/null
    progress_task_finish workspace image done "Docker workspace image ready"
  elif [[ "$SERVER_ONLY" -eq 1 ]] && have sg && id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
    say "Preparing Docker workspace image"
    sg docker -c "$(printf '%q' "$RUNTIME/bin/vulcan") install --runtime-only" >/dev/null || fail "Could not prepare the Docker workspace image with the newly-added docker group"
    progress_task_finish workspace image done "Docker workspace image ready"
  else
    progress_task_finish workspace image skipped "Workspace image deferred until session refresh"
  fi

  progress_task_start services service "Starting Vulcan service"
  say "Starting Vulcan services"
  ensure_vulcan_service_linux
  progress_task_finish services service done "Vulcan service running"

  progress_task_start services health "Checking Vulcan server health"
  if [[ "$relogin" == 0 ]]; then
    wait_server || fail "Vulcan server did not become healthy on port 8468"
    progress_task_finish services health done "Vulcan server healthy on port 8468"
  else
    progress_task_finish services health skipped "Health check deferred until new login session"
  fi

  # Successful desktop convergence continues in the launching Electron process.
  # The persisted AppImage is used naturally by later desktop/app-menu launches.
  emit_ok "" "$relogin"
  if [[ "$SERVER_ONLY" -eq 1 && "$relogin" == 0 ]]; then
    progress_conclusion "Vulcan server ready on http://localhost:8468"
  fi
}

macos_host_converge() {
  # Electron itself handles moving Vulcan.app into Applications.  This script
  # owns the Linux backend substrate.
  if ! have brew; then
    warn "Homebrew is required to install Colima automatically on macOS"
    if [[ "$JSON_MODE" -eq 1 ]]; then printf 'VULCAN_RESULT={"ok":false,"needsHomebrew":true,"message":"Homebrew is required for the Colima backend"}\n'; fi
    exit 30
  fi
  # Keep Etna native on macOS so Playwright can drive the user's visible Chrome
  # and client-POV tools remain truly host-local. Only the Vulcan server lives in Colima.
  ensure_etna
  if ! have colima; then say "Installing Colima"; brew install colima >/dev/null; fi

  say "Starting Vulcan Colima profile"
  colima start vulcan --runtime docker >/dev/null

  [[ -n "$SERVER_SOURCE" && -d "$SERVER_SOURCE" ]] || fail "Packaged Vulcan server payload is missing"
  local wanted_hash guest_hash
  wanted_hash="$(server_payload_hash)"
  guest_hash="$(colima -p vulcan ssh -- sh -lc 'if [ -f "$HOME/.vulcan/payload/server-payload.sha256" ] && [ -f "$HOME/.vulcan/payload/server/pyproject.toml" ]; then tr -d "[:space:]" < "$HOME/.vulcan/payload/server-payload.sha256"; fi' 2>/dev/null || true)"

  # The payload is immutable for a given desktop build.  Avoid copying it into
  # the VM on every healthy launch; only refresh it when the packaged hash changes
  # or the guest copy is missing.
  if [[ "$guest_hash" != "$wanted_hash" ]]; then
    say "Refreshing Vulcan server payload in Colima"
    local tmp_tar tmp_hash
    tmp_tar="$(mktemp -t vulcan-server.XXXXXX).tar.gz"
    tmp_hash="$(mktemp -t vulcan-hash.XXXXXX)"
    tar -C "$SERVER_SOURCE" -czf "$tmp_tar" .
    printf '%s\n' "$wanted_hash" > "$tmp_hash"

    colima -p vulcan ssh -- sh -lc 'rm -rf "$HOME/.vulcan/payload/server"; mkdir -p "$HOME/.vulcan/payload/server"; cat > /tmp/vulcan-server.tar.gz' < "$tmp_tar"
    colima -p vulcan ssh -- sh -lc 'tar -xzf /tmp/vulcan-server.tar.gz -C "$HOME/.vulcan/payload/server"; rm -f /tmp/vulcan-server.tar.gz'
    colima -p vulcan ssh -- sh -lc 'mkdir -p "$HOME/.vulcan/payload"; cat > "$HOME/.vulcan/payload/server-payload.sha256"' < "$tmp_hash"
    rm -f "$tmp_tar" "$tmp_hash"
  fi

  # Run this same converger inside the Linux VM. Resolve the guest home first
  # so payload paths are absolute arguments, not unevaluated '$HOME' strings.
  local guest_home
  guest_home="$(colima -p vulcan ssh -- sh -lc 'printf %s "$HOME"')"
  [[ -n "$guest_home" ]] || fail "Could not resolve the Colima guest home directory"
  colima -p vulcan ssh -- bash -s -- \
    --guest macos-colima \
    --server-source "$guest_home/.vulcan/payload/server" \
    --server-hash-file "$guest_home/.vulcan/payload/server-payload.sha256" \
    --version "$VERSION" < "$0"

  # Colima/Lima automatically forwards guest listening ports to the macOS host,
  # so a Vulcan server on guest :8468 is available at host localhost:8468.
  # A LaunchAgent starts the named profile at login; Colima owns its own VM and
  # port-forwarding lifecycle after the start command returns.
  local launch_dir launch_file colima_bin
  colima_bin="$(command -v colima)"
  launch_dir="$HOME/Library/LaunchAgents"
  launch_file="$launch_dir/com.vulcan.backend.plist"
  mkdir -p "$launch_dir"
  cat > "$launch_file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.vulcan.backend</string>
  <key>ProgramArguments</key><array>
    <string>$colima_bin</string><string>start</string><string>vulcan</string>
    <string>--runtime</string><string>docker</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>
PLIST
  launchctl bootout "gui/$(id -u)" "$launch_file" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$launch_file" >/dev/null 2>&1 || launchctl load "$launch_file" >/dev/null 2>&1 || true

  # Validate the actual desktop-side contract before declaring convergence.
  local mac_ready=0
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 1 http://127.0.0.1:8468/meta >/dev/null 2>&1; then mac_ready=1; break; fi
    sleep .25
  done
  [[ "$mac_ready" -eq 1 ]] || fail "Vulcan server did not become reachable through Colima localhost forwarding"
  emit_ok "" 0
}

# Public one-command installers:
#   Desktop Linux: curl -fsSL https://raw.githubusercontent.com/dwhite-sys/vulcan/main/install.sh | bash
#   Headless:      curl -fsSL https://raw.githubusercontent.com/dwhite-sys/vulcan/main/install.sh | bash -s -- --server-only
#
# The desktop path downloads the AppImage, verifies it against GitHub's release
# asset SHA-256 digest, then delegates to the converger embedded in that artifact.
# --server-only downloads the selected release's GitHub source archive and invokes
# that tag's installer against only its Vulcan server package; it never installs
# Electron, a .desktop entry, an icon, or desktop autostart integration.
# Explicit --server-source/--guest modes bypass both network bootstrap wrappers.
if [[ "$SERVER_ONLY" -eq 1 && "$FROM_APP" -eq 0 && -z "$GUEST" && "$SERVER_SOURCE_EXPLICIT" -eq 0 && -z "$RESOURCES_DIR" ]]; then
  standalone_server_bootstrap
  exit 0
fi
if [[ "$FROM_APP" -eq 0 && -z "$GUEST" && "$SERVER_SOURCE_EXPLICIT" -eq 0 && -z "$RESOURCES_DIR" ]]; then
  case "$OS" in
    Linux)
      standalone_linux_bootstrap
      exit 0
      ;;
    Darwin)
      standalone_macos_bootstrap
      exit 0
      ;;
  esac
fi

# Source-tree/development fallback. Production AppImage/guest calls always pass a
# resources or server-source path explicitly.
if [[ -z "$SERVER_SOURCE" && -d "$(cd "$(dirname "$0")" && pwd)/vulcan" ]]; then
  SERVER_SOURCE="$(cd "$(dirname "$0")/vulcan" && pwd)"
fi

case "$OS" in
  Linux) linux_converge ;;
  Darwin)
    [[ -z "$GUEST" ]] || fail "Darwin cannot be used as a Linux guest"
    macos_host_converge
    ;;
  *) fail "install.sh supports Linux and macOS; Windows uses install.ps1" ;;
esac
