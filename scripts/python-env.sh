#!/usr/bin/env bash
# Shared by the source launcher and native macOS build. Apple's /usr/bin/python3
# may be older than the application supports, even with a newer Python installed.
select_python() {
  local candidate
  if [[ -n "${SCRIPTSURGEON_PYTHON:-}" ]]; then
    if "$SCRIPTSURGEON_PYTHON" -c 'import sys; sys.exit(sys.version_info[:2] not in ((3, 11), (3, 12)))' 2>/dev/null; then
      return 0
    fi
    echo "SCRIPTSURGEON_PYTHON must point to Python 3.11 or 3.12: $SCRIPTSURGEON_PYTHON" >&2
    return 1
  fi
  for candidate in python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && \
      "$candidate" -c 'import sys; sys.exit(sys.version_info[:2] not in ((3, 11), (3, 12)))' 2>/dev/null; then
      SCRIPTSURGEON_PYTHON="$(command -v "$candidate")"
      return 0
    fi
  done
  echo 'Python 3.11 or 3.12 is required. Install one or set SCRIPTSURGEON_PYTHON to its executable.' >&2
  return 1
}

check_node() {
  if ! command -v node >/dev/null 2>&1 || ! node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22 ? 0 : 1);
  '; then
    echo 'Node.js 20.19+ or 22.12+ is required by the frontend build.' >&2
    return 1
  fi
}
