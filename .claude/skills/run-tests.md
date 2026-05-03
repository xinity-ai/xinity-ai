# Run Tests

End-to-end procedure for verifying every test suite in the workspace runs green locally. Use when validating dependency changes, refactors, or anything else that could plausibly affect runtime behavior across packages. Runs in three sequential phases: non-dashboard package tests, system tests, then dashboard tests.

## Phase 0: kick off the dashboard build in the background

Phase 3 needs the dashboard's production build before its preview server can start. The build takes a couple of minutes, so kick it off as a background task right at the beginning so it overlaps with phases 1 and 2:

```bash
cd packages/xinity-ai-dashboard && bun run build
```

Use the `Bash` tool with `run_in_background: true`. Save the resulting shell ID. By the time phases 1 and 2 finish, the build is usually done; if not, wait on it before phase 3.

## Prerequisites you bring up yourself

Bring these up as needed; don't ask the user to do it.

| Phase needs | What must be running | How to start it |
|---|---|---|
| Phase 1 | nothing extra | (none) |
| Phase 2 | docker compose stack (Postgres, Mailhog, etc.) | `docker compose up -d` from repo root |
| Phase 3 | dashboard preview, infoserver dev, plus the docker stack from phase 2 | After phase 0's build finishes: `LOG_LEVEL=info bun run preview` in [packages/xinity-ai-dashboard](packages/xinity-ai-dashboard) (run in background); `bun run dev` in [packages/xinity-infoserver](packages/xinity-infoserver) (run in background) |

`LOG_LEVEL=info` on the dashboard preview is important: the default log level is much noisier, and the volume of log output blows up Claude's context for no benefit.

## Phase 1: non-dashboard package tests

Discover packages dynamically rather than hardcoding the list (workspace membership changes over time):

```bash
for pkg_dir in packages/*/; do
  name=$(jq -r .name "$pkg_dir/package.json")
  has_test=$(jq -r '.scripts.test // empty' "$pkg_dir/package.json")
  if [ "$name" != "xinity-ai-dashboard" ] && [ -n "$has_test" ]; then
    echo "$name"
  fi
done
```

Run the discovered packages' `bun run test` scripts in parallel via separate `Bash` tool calls in a single message. They are independent: no shared state, no services. Every package must report 0 fails.

Report counts back as a small table. If any package fails, surface the failure and stop. Do not modify test code without instruction.

## Phase 2: system tests

```bash
bun run test:system   # from repo root
```

Reads from `tests/system/`. Hits the real Postgres in the docker stack, plus other services that get spun up per-test. SeaweedFS-dependent tests self-skip if SeaweedFS isn't reachable; that's expected and not a failure.

## Phase 3: dashboard tests

By now the phase 0 background build should be finished. Start the dashboard preview (with `LOG_LEVEL=info`) and infoserver dev yourself in the background, give them a few seconds to come up, then:

```bash
cd packages/xinity-ai-dashboard && bun run test
```

This runs both the small in-package unit tests and the full `e2e/` suite, which hits the running preview server + infoserver. Expect roughly 90 seconds of wall time. If the count of test files in the output looks low compared to what `find packages/xinity-ai-dashboard -name '*.test.ts' -not -path '*/node_modules/*' | wc -l` reports, the e2e suite is being skipped: check that the preview server is actually reachable.

## Phase 4: tear down what you brought up

After phase 3 finishes (pass or fail), shut down everything this skill started so nothing keeps running in the background:

- `TaskStop` the dashboard preview and infoserver background tasks (use the IDs you saved when starting them).
- `docker compose down` from the repo root to stop the docker stack.

The phase 0 build task exits on its own and does not need to be stopped. Do not skip teardown on failure: leftover servers and containers will block the next run.

## Reporting back

After each phase, report a one-line summary per package:

```
xinity-ai-daemon: 80 pass, 3 skip
xinity-ai-gateway: 235 pass
...
```

After all three phases pass, summarize as a single table. If anything failed, surface the failure clearly and stop. Do not attempt to repair test code without instruction.

## Common issues

- **`Cannot find module 'X'` from a test**: the package likely imports a dep it does not declare in its own `package.json` (was relying on bun hoisting). Add it as a direct devDep on the package that imports it.
- **Dashboard e2e timeouts**: preview server probably is not running, or `LOG_LEVEL=info` was forgotten and stdout is overflowing. Check both before retrying.
- **System tests cannot reach Postgres**: docker stack is not up. Run `docker compose up -d` yourself.
