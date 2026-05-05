#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/release.sh [small|mid|large]

small  Bump patch version. Default.
mid    Bump minor version and reset patch.
large  Bump major version and reset minor/patch.

The script:
  - runs npm checks
  - derives the last release from git tags matching vX.Y.Z
  - uses 0.0.1 as the first release when no version tag exists
  - updates package.json and package-lock.json
  - commits, tags, and pushes branch + tag

Pushing the tag triggers .github/workflows/publish.yml.
EOF
}

bump_kind="${1:-small}"
case "$bump_kind" in
  small|mid|large) ;;
  -h|--help) usage; exit 0 ;;
  *) echo "invalid bump kind: $bump_kind" >&2; usage >&2; exit 2 ;;
esac

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

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "missing git remote: origin" >&2
  exit 1
fi

npm ci
npm run check
npm run pack:dry-run

git fetch --tags origin

last_tag="$(
  git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname \
    | head -n 1
)"

if [[ -z "$last_tag" ]]; then
  next_version="0.0.1"
else
  last_version="${last_tag#v}"
  IFS=. read -r major minor patch <<<"$last_version"
  case "$bump_kind" in
    small) patch=$((patch + 1)) ;;
    mid) minor=$((minor + 1)); patch=0 ;;
    large) major=$((major + 1)); minor=0; patch=0 ;;
  esac
  next_version="$major.$minor.$patch"
fi

next_tag="v$next_version"
if git rev-parse -q --verify "refs/tags/$next_tag" >/dev/null; then
  echo "tag already exists: $next_tag" >&2
  exit 1
fi

npm version "$next_version" --no-git-tag-version

git add package.json package-lock.json
git commit -m "Release $next_version"
git tag -a "$next_tag" -m "Release $next_version"

git push origin "$current_branch"
git push origin "$next_tag"

echo "Released $next_version via $next_tag"
