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
  - promotes the latest dev release tag to main, fast-forwarding when possible
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
if git rev-parse -q --verify refs/remotes/origin/dev >/dev/null; then
  if ! git merge-base --is-ancestor refs/remotes/origin/dev "$dev_tag"; then
    echo "latest dev tag is behind origin/dev: $dev_tag" >&2
    echo "Run scripts/dev-release.sh first, or pass --dev-tag for the exact dev build to promote." >&2
    exit 1
  fi
fi
if git rev-parse -q --verify refs/heads/dev >/dev/null; then
  if ! git merge-base --is-ancestor refs/heads/dev "$dev_tag"; then
    echo "latest dev tag is behind local dev: $dev_tag" >&2
    echo "Run scripts/dev-release.sh first, or pass --dev-tag for the exact dev build to promote." >&2
    exit 1
  fi
fi

git switch main
git pull --ff-only origin main
last_tag="$(
  git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname \
    | head -n 1
)"
dev_version="${dev_tag#dev/v}"
dev_base_version="${dev_version%%-*}"
if git merge-base --is-ancestor "$dev_tag" HEAD; then
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
  if git merge-base --is-ancestor HEAD "$dev_tag"; then
    git merge --ff-only "$dev_tag"
  else
    echo "main and $dev_tag diverged; merging dev tag into main"
    git merge --no-edit -X theirs "$dev_tag"
  fi
fi

if [[ "$skip_checks" == false ]]; then
  npm ci
  npm run check
  npm run pack:dry-run
fi

next_version="$(
  node - "$last_tag" "$dev_base_version" "$bump_kind" <<'NODE'
const [lastTagRaw, devBaseRaw, bumpKind] = process.argv.slice(2);

function parseVersion(raw, label) {
  const version = (raw || "").replace(/^v/, "");
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    console.error(`invalid ${label} version: ${raw}`);
    process.exit(1);
  }
  return match.slice(1).map(Number);
}

function compare(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

const devBase = parseVersion(devBaseRaw, "dev base");
let next;
if (!lastTagRaw) {
  next = [0, 0, 1];
} else {
  next = parseVersion(lastTagRaw, "latest production tag");
  switch (bumpKind) {
    case "small":
      next[2] += 1;
      break;
    case "mid":
      next[1] += 1;
      next[2] = 0;
      break;
    case "large":
      next[0] += 1;
      next[1] = 0;
      next[2] = 0;
      break;
    default:
      console.error(`invalid bump: ${bumpKind}`);
      process.exit(1);
  }
}

if (compare(next, devBase) < 0) {
  next = devBase;
}
console.log(next.join("."));
NODE
)"

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
