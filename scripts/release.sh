#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/release.sh [small|mid|large] [--dev-tag dev/vX.Y.Z-dev...] [--skip-checks] [--skip-push]

small  Bump patch version. Default.
mid    Bump minor version and reset patch.
large  Bump major version and reset minor/patch.

The script:
  - requires a clean working tree
  - fetches origin/main, origin/dev, and tags
  - promotes the latest dev release tag to main with a fast-forward merge
  - runs npm checks
  - updates package.json and package-lock.json
  - commits, creates vX.Y.Z, and pushes main + tag

Pushing the production tag triggers .github/workflows/publish.yml.
EOF
}

bump_kind="small"
dev_tag=""
skip_checks=false
skip_push=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    small|mid|large) bump_kind="$1" ;;
    --skip-checks) skip_checks=true ;;
    --skip-push) skip_push=true ;;
    --dev-tag)
      if [[ $# -lt 2 ]]; then
        echo "--dev-tag requires a value" >&2
        exit 2
      fi
      dev_tag="$2"
      shift
      ;;
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

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "missing git remote: origin" >&2
  exit 1
fi

git fetch origin main dev --tags

if [[ -z "$dev_tag" ]]; then
  dev_tag="$(
    git tag --list 'dev/v[0-9]*.[0-9]*.[0-9]*-dev.*' --sort=-creatordate \
      | head -n 1
  )"
fi
if [[ -z "$dev_tag" ]]; then
  echo "no dev release tag found; run scripts/dev-release.sh from branch dev first" >&2
  exit 1
fi
if ! git rev-parse -q --verify "refs/tags/$dev_tag" >/dev/null; then
  echo "unknown dev tag: $dev_tag" >&2
  exit 1
fi
if ! git ls-remote --exit-code --tags origin "refs/tags/$dev_tag" >/dev/null; then
  echo "dev tag $dev_tag has not been pushed to origin" >&2
  exit 1
fi

git switch main
git pull --ff-only origin main
last_tag="$(
  git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname \
    | head -n 1
)"
if git merge-base --is-ancestor "$dev_tag" HEAD; then
  dev_version="${dev_tag#dev/v}"
  dev_base_version="${dev_version%%-*}"
  latest_prod_version="${last_tag#v}"
  latest_prod_covers_dev="$(
    node - "$latest_prod_version" "$dev_base_version" <<'NODE'
const [prodRaw, devBaseRaw] = process.argv.slice(2);

function parse(version) {
  const match = (version || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const prod = parse(prodRaw);
const devBase = parse(devBaseRaw);
console.log(prod && devBase && compare(prod, devBase) >= 0 ? "yes" : "no");
NODE
  )"
  if [[ -n "$last_tag" ]] \
    && [[ "$latest_prod_covers_dev" == "yes" ]] \
    && [[ "$(git rev-parse HEAD)" == "$(git rev-parse "$last_tag^{commit}")" ]]; then
    echo "dev tag $dev_tag is already released as $last_tag"
    exit 0
  fi
  echo "dev tag $dev_tag is already contained in main; continuing release from current main"
else
  git merge --ff-only "$dev_tag"
fi

if [[ "$skip_checks" == false ]]; then
  npm ci
  npm run check
  npm run pack:dry-run
fi

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

npm version "$next_version" --no-git-tag-version --allow-same-version

git add package.json package-lock.json
if git diff --cached --quiet; then
  echo "package metadata already at $next_version; tagging current HEAD"
else
  git commit -m "Release $next_version"
fi
git tag -a "$next_tag" -m "Release $next_version"

if [[ "$skip_push" == false ]]; then
  git push origin main
  git push origin "$next_tag"
fi

echo "Released $next_version via $next_tag from $dev_tag"
