#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -z "${PLAYWRIGHT_PORT:-}" && -f .worktree-env ]]; then
  source .worktree-env
fi
exec npx playwright test "$@"
