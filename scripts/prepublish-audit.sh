#!/usr/bin/env bash
# Scan for secrets before the repo goes public. Usage: scripts/prepublish-audit.sh [--history]
# Runs in the current git repository; needs only bash, git and bun. Exit 1 on any hit.
set -euo pipefail
exec bun "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prepublish-audit.ts" "$@"
