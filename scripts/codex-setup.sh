#!/usr/bin/env bash
# Prepare this repository for Codex without fetching market data or retraining models.
set -euo pipefail

CAISO_SETUP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CAISO_SETUP_RESEARCH=0
CAISO_SETUP_WORKBENCH=0

usage() {
  cat <<'USAGE'
Usage: bash scripts/codex-setup.sh [--research] [--workbench]

Default:
  Install the locked viewer dependencies, build the read-only website, and
  verify the published data and frozen V4 replay with Python's standard library.

Options:
  --research   Also create .venv and install the pinned research requirements.
               This does not train a model or collect external market data.
  --workbench  Also install and check the complete workbench application.
               This does not initialize a development/production database.
  -h, --help   Show this help.

Neither the default flow nor either option deploys a website or a Codex environment.
USAGE
}

for CAISO_SETUP_ARG in "$@"; do
  case "$CAISO_SETUP_ARG" in
    --research) CAISO_SETUP_RESEARCH=1 ;;
    --workbench) CAISO_SETUP_WORKBENCH=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$CAISO_SETUP_ARG" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$CAISO_SETUP_ROOT"

for CAISO_SETUP_COMMAND in node npm python3; do
  if ! command -v "$CAISO_SETUP_COMMAND" >/dev/null 2>&1; then
    printf 'Required command is missing: %s\n' "$CAISO_SETUP_COMMAND" >&2
    exit 1
  fi
done

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write("Node.js >= 22.13.0 is required.\n");
  process.exit(1);
}
'

printf '%s\n' 'Installing the locked viewer dependencies...'
npm run setup
printf '%s\n' 'Building the read-only website...'
npm run build
printf '%s\n' 'Verifying published data and frozen V4 results...'
npm run verify

if [[ "$CAISO_SETUP_RESEARCH" == 1 ]]; then
  python3 -c 'import sys; assert sys.version_info >= (3, 11), "Research dependencies require Python >= 3.11; Python 3.12 was used for the frozen experiments."'
  printf '%s\n' 'Preparing optional research dependencies in .venv...'
  python3 -m venv "$CAISO_SETUP_ROOT/.venv"
  "$CAISO_SETUP_ROOT/.venv/bin/python" -m pip install \
    -r "$CAISO_SETUP_ROOT/apps/workbench/research/requirements.txt"
  "$CAISO_SETUP_ROOT/.venv/bin/python" -m pip check
fi

if [[ "$CAISO_SETUP_WORKBENCH" == 1 ]]; then
  printf '%s\n' 'Installing and checking the optional workbench...'
  npm ci --prefix apps/workbench
  npm --prefix apps/workbench run typecheck
  npm --prefix apps/workbench run test
  npm --prefix apps/workbench run build
fi

printf '%s\n' 'Local setup and requested checks completed. No model was retrained and no remote service was deployed.'
