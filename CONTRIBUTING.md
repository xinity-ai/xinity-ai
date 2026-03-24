# Contributing

Thanks for your interest in Xinity AI. We welcome issues, bug reports, and PRs.

## How to contribute

- **Issues first**: Open or comment on an issue before large changes to align on scope.
- **Small PRs**: Prefer focused PRs that are easy to review.
- **Tests**: Add or update tests when behavior changes.
- **Docs**: Update documentation when you change behavior or configuration.

## Scope boundaries

To keep the project focused:

- We accept fixes and improvements to any part of the codebase. Note that the dashboard is source-available under a separate license; contributions to it are welcome but subject to that license.
- Features that significantly change the architecture should be discussed with maintainers first.
- Breaking changes should be discussed in an issue before implementation.
- Security issues should not be disclosed publicly; contact security@xinity.ai to coordinate a fix.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/). A `commitlint` git hook enforces the format on every commit.

**Format:** `<type>[optional scope]: <description>`

Common types:

| Type | When to use |
|------|-------------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `build` | Build system or dependency changes |
| `ci` | CI/CD configuration |
| `chore` | Maintenance tasks (deps, tooling) |

Scopes are optional but can reference package names: `feat(gateway): add rate limiting`.

Breaking changes use `!` after the type: `feat!: remove legacy auth endpoint`.

## Changelog

New release entries are prepended to [CHANGELOG.md](CHANGELOG.md) by [git-cliff](https://git-cliff.org/) during `bun run bump`. Historical entries are preserved as-is. Do not edit the file by hand. To preview unreleased changes:

```bash
bun run changelog:preview
```

## Adding or removing workspace packages

Each service Dockerfile copies every workspace `package.json` so that `bun install --frozen-lockfile` can resolve the lockfile. These COPY lines are auto-managed by `scripts/sync-dockerfile-manifests.ts` between `# [sync:workspace-manifests]` markers.

After adding, removing, or renaming a package under `packages/`, run:

```bash
bun run sync:dockerfiles
```

CI enforces this: the `dockerfile-sync` job in `tests.yml` runs `bun run sync:dockerfiles:check` and will fail if the Dockerfiles are out of date.

## Style and workflow

- Use the existing code style in each package.
- Keep commits descriptive and scoped to one change.
- If a change affects multiple packages, note it in the PR description.
