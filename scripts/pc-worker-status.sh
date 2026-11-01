#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec "$SCRIPT_DIR/../node_modules/.bin/tsx" "$SCRIPT_DIR/pc-worker-status.mjs" "$@"
