#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/dev-release.sh [--skip-checks] [--skip-push] [--allow-branch]

Creates a unique dev release tag from the dev branch.

The script:
  - requires a clean working tree
  - requires the current branch to be dev unless --allow-branch is provided
  - derives X.Y.(Z+1)-dev.YYYYMMDDHHMMSS.sha from package.json and HEAD
  - runs checks unless --skip-checks is provided
  - creates an annotated git tag named dev/vX.Y.Z-dev...
  - pushes the branch and tag unless --skip-push is provided

Pushing the dev tag triggers .github/workflows/publish.yml, which publishes
the package under the npm `dev` dist-tag.
EOF
}

skip_checks=false
skip_push=false
allow_branch=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-checks) skip_checks=true ;;
    --skip-push) skip_push=true ;;
    --allow-branch) allow_branch=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "invalid argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree has uncommitted changes; commit or stash them first" >&2
  exit 1
fi

current_branch="$(git branch --show-current)"
if [[ -z "$current_branch" ]]; then
  echo "not on a branch" >&2
  exit 1
fi
if [[ "$allow_branch" == false && "$current_branch" != "dev" ]]; then
  echo "dev releases must be created from branch dev; current branch is $current_branch" >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "missing git remote: origin" >&2
  exit 1
fi

current_version="$(node -p "require('./package.json').version")"
base_version="${current_version%%-*}"
IFS=. read -r major minor patch <<<"$base_version"
if [[ -z "${major:-}" || -z "${minor:-}" || -z "${patch:-}" ]]; then
  echo "invalid package version: $current_version" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%d%H%M%S)"
sha="$(git rev-parse --short=8 HEAD)"
dev_version="$major.$minor.$((patch + 1))-dev.$timestamp.$sha"
dev_tag="dev/v$dev_version"

git fetch --tags origin
if git rev-parse -q --verify "refs/tags/$dev_tag" >/dev/null; then
  echo "tag already exists: $dev_tag" >&2
  exit 1
fi

if [[ "$skip_checks" == false ]]; then
  npm ci
  npm run check
  npm run pack:dry-run
fi

git tag -a "$dev_tag" -m "Dev release $dev_version"

if [[ "$skip_push" == false ]]; then
  git push origin "$current_branch"
  git push origin "$dev_tag"
fi

echo "$dev_version"
