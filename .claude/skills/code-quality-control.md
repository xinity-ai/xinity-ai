# Code Quality Control

When reviewing or writing code in this codebase, apply these quality standards. This skill can be triggered explicitly or used as a checklist before completing work on any file.

## Comments and Documentation

### Remove These

- **File-level doc comments** that restate what the file does when the exports already make it obvious. A file named `deployment.procedure.ts` exporting `createDeployment`, `listDeployments`, etc. does not need a `/** ORPC procedures for deployment management. */` header.
- **Function doc comments that restate the function name**: `/** Soft deletes an API key. */` above `deleteApiKey` adds nothing. Remove them.
- **Comments restating the next line of code**: `// Check if key is disabled` before `if (!apiKeyObj.enabled)` is noise.
- **Decorative section banners** using long lines of `─── ` or `// -----------` characters. Replace with a plain `// Section Name` only where a section boundary genuinely helps navigation (e.g., separating types from implementation in a long file). Most can just be deleted.

### Keep These

- Comments explaining **why** (business logic, non-obvious constraints, workarounds)
- Comments on **tricky algorithms** or **security-sensitive code** where the intent is not obvious from the code
- TODO comments that track known issues

### Condense These

- Multi-paragraph inline comments explaining implementation trade-offs. Keep the key insight, cut to ~5 lines max. If more detail is needed, link to an ADR or doc.

## Functions and Structure

### Extract When

- A code block appears **twice or more** with the same logic (e.g., TCP socket probes, slug generation, mock server setup). Factor into a shared helper.
- A function exceeds ~60 lines and contains logically distinct phases. Extract named functions for each phase to improve readability.
- A nested callback or promise chain is more than 3 levels deep.

### Don't Extract When

- The "duplication" is just similar-looking Zod schemas or DB queries with different columns. These are better left inline for clarity.
- A function is long but linear (sequential steps with no branching), e.g. a sequence of DB queries in a data loader is fine as-is if each step is clear.

## Common Patterns to Fix

### Duplicate Utilities Across Test Files

Test helper files (`*-test-helpers.ts`) frequently duplicate utilities like `readProcessOutput`, `getAvailablePort`, or mock server factories. Move shared utilities to the common `tests/system/test-helpers.ts`.

### Console.log in Production Code

Replace `console.log` debug statements with proper structured logging (pino/rootLogger in dashboard, or remove entirely in gateway where metrics handle observability). Debug `console.log` calls should hardly never ship.

### Inconsistent Error/Cancel Handling

When a module imports a shared `cancelAndExit()` helper but some code paths do inline `p.cancel("Cancelled."); process.exit(0)` instead, unify them to use the helper.

### TextEncoder/TextDecoder in Loops

`new TextEncoder()` is cheap but should still be hoisted to module scope when used inside hot loops (streaming handlers). Same for `TextDecoder`.

### Sequential Independent Queries

When a function runs multiple independent database queries sequentially (`await query1; await query2; ...`), wrap them in `Promise.all([query1, query2, ...])` for parallelism. Only do this when the queries don't depend on each other's results.

### Double Middleware Wrapping

Watch for accidental double wrapping like `createAuthMiddleware(createAuthMiddleware(async (ctx) => {...}))`. This is a bug: the inner wrapper runs the middleware pipeline twice.

## Unused Code

- Remove unused imports, functions, and variables. Don't leave them commented out.
- Remove commented-out code blocks. If the code is needed later, it's in git history.
- Remove unused type-level `satisfies` or `as` casts that no longer serve a purpose.

## Process

When running a code quality pass:

1. Find the longest files: `find . -name '*.ts' -o -name '*.svelte' | grep -v node_modules | grep -v .svelte-kit | xargs wc -l | sort -rn | head -40`
2. Start with the largest files, as they tend to accumulate the most issues.
3. For each file, scan for: redundant comments, extractable duplications, console.log leaks, sequential parallelizable queries, unused code.
4. Make changes, then verify with the package's typecheck or test command.
5. Keep changes behavior-preserving unless a bug is found (like double middleware wrapping).