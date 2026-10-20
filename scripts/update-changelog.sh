#!/usr/bin/env bash
set -euo pipefail

# Called by the Release workflow once the version is set in package.json,
# before the release commit.
VERSION=$(jq -r .version package.json)
bunx git-cliff --unreleased --prepend CHANGELOG.md --tag "v${VERSION}"
