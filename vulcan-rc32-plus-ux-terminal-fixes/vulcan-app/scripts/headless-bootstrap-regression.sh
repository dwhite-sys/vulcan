#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p \
  "$TMP/source/vulcan" \
  "$TMP/home"

cat > "$TMP/source/install.sh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail

server_only=0
server_source=""
version=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-only)
      server_only=1
      shift
      ;;
    --server-source)
      server_source="${2:-}"
      shift 2
      ;;
    --version)
      version="${2:-}"
      shift 2
      ;;
    *)
      printf 'unexpected argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

[[ "$server_only" -eq 1 ]]
[[ -f "$server_source/pyproject.toml" ]]
[[ "$version" == "9.9.9-test" ]]
printf 'ok\n' > "$VULCAN_BOOTSTRAP_TEST_MARKER"
INNER

chmod +x "$TMP/source/install.sh"

cat > "$TMP/source/vulcan/pyproject.toml" <<'EOF_PY'
[project]
name = "fake-vulcan"
version = "0"
EOF_PY

tar -C "$TMP" -czf "$TMP/source.tar.gz" source

HOME="$TMP/home" \
VULCAN_SOURCE_TARBALL_URL="file://$TMP/source.tar.gz" \
VULCAN_BOOTSTRAP_TEST_MARKER="$TMP/marker" \
bash "$ROOT/install.sh" \
  --server-only \
  --release v9.9.9-test \
  >/dev/null

grep -Fxq 'ok' "$TMP/marker"

echo "Headless tagged-source bootstrap verified."
