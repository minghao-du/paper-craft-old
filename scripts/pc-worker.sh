#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
case "${1-}" in
  status|wait|release) action=$1; shift; exec bash "$SCRIPT_DIR/pc-worker-$action.sh" "$@" ;;
  ''|--help|-h)
    echo 'Usage: pc worker <status|wait|release> [options]'
    echo 'Task dispatch is owned by the workflow Orchestrator.' ;;
  *) echo "Unknown worker command: $1" >&2; exit 1 ;;
esac
