#!/usr/bin/env bash
set -euo pipefail

# Called by bumpp --execute after the version is bumped in package.json
# but before the git commit. Reads the version from package.json since
# bumpp's %s placeholder doesn't work in --execute.
VERSION=$(jq -r .version package.json)
bunx git-cliff --unreleased --prepend CHANGELOG.md --tag "v${VERSION}"
