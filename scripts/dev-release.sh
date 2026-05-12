#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/dev-release.sh [--skip-checks] [--skip-publish]

Publishes a unique prerelease build to npm under the `dev` dist-tag.

The script:
  - derives the next patch from package.json
  - stamps package.json/package-lock.json as X.Y.(Z+1)-dev.YYYYMMDDHHMMSS.sha
  - runs checks unless --skip-checks is provided
  - publishes with npm tag `dev` unless --skip-publish is provided
  - restores package.json/package-lock.json before exiting

This is intentionally not a release commit path. Commit normal source changes,
push them, then run this script to publish an installable dev build.
EOF
}

skip_checks=false
skip_publish=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-checks) skip_checks=true ;;
    --skip-publish) skip_publish=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "invalid argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

current_version="$(node -p "require('./package.json').version")"
base_version="${current_version%%-*}"
IFS=. read -r major minor patch <<<"$base_version"
if [[ -z "${major:-}" || -z "${minor:-}" || -z "${patch:-}" ]]; then
  echo "invalid package version: $current_version" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%d%H%M%S)"
sha="$(git rev-parse --short=8 HEAD 2>/dev/null || echo local)"
dev_version="$major.$minor.$((patch + 1))-dev.$timestamp.$sha"

restore_version() {
  npm version "$current_version" --no-git-tag-version --allow-same-version >/dev/null 2>&1 || true
}
trap restore_version EXIT

npm version "$dev_version" --no-git-tag-version --allow-same-version >/dev/null

if [[ "$skip_checks" == false ]]; then
  npm run check
  npm run pack:dry-run
fi

if [[ "$skip_publish" == false ]]; then
  npm publish --access public --tag dev
fi

echo "$dev_version"
