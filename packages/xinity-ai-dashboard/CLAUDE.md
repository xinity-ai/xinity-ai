# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run dev              # Dev server (pipes through pino-pretty for logs)
bun run build            # Production build
bun run preview          # Preview production build
bun run check            # Type-check (svelte-kit sync + svelte-check)
bun run check:watch      # Type-check in watch mode
```

Add shadcn-svelte components:
```bash
bun x shadcn-svelte@latest add <component-name>
```

Local services (from monorepo root):
```bash
docker compose up -d dev   # PostgreSQL + Mailhog (UI: localhost:8025)
```

## Architecture

This is a **SvelteKit 2 + Svelte 5** dashboard using Bun as runtime and package manager. It lives at `packages/xinity-ai-dashboard` in a monorepo and depends on workspace packages `common-db` (database schema/utilities) and `xinity-infoserver`.

### API Layer (oRPC)

Two endpoints serve the same procedures:
- `/rpc/[...rest]`, JSON-RPC (used internally by the SvelteKit app)
- `/api/[...rest]`, OpenAPI-compatible REST (external integrations)

Server procedures live in `src/lib/server/orpc/procedures/`. Each procedure uses middleware from `src/lib/server/orpc/root.ts`:
- `withAuth`, requires authenticated session
- `withOrganization`, requires active organization
- `requirePermission({resource: [actions]})`, RBAC enforcement

The client-side oRPC instance is in `src/lib/orpc/orpc-client.ts`.

### Auth & RBAC

Authentication uses **Better Auth** with plugins: two-factor, passkey, organization, SSO, API key, bearer.

RBAC is defined in `src/lib/roles.ts` (client-safe) and enforced server-side via oRPC middleware. Five roles: **owner, admin, member, labeler, viewer**. Resources: apiKey, apiCall, apiCallResponse, modelDeployment, model, aiApplication, plus default org resources (organization, member, invitation).

Client-side permission checks use `src/lib/state/permissions.svelte.ts`.

### Routing

- `(authenticated)/` route group, all protected pages
- Public routes: `/login`, `/api`, `/rpc`, `/log`, `/metrics`
- Dynamic params use UUID matchers: `[applicationId=uuid]`

### UI

- **Tailwind CSS 4** via Vite plugin, OKLCH color system in `src/app.css`
- **shadcn-svelte** (bits-ui) for UI primitives in `src/lib/components/ui/`
- **Lucide** icons via `@lucide/svelte`
- Custom components in `src/lib/components/`

### State

Uses Svelte 5 runes (`$state`, `$derived`, `$props`). Reactive stores as classes in `src/lib/state/`.

### Server-only Code

All server-only modules are in `src/lib/server/`:
- `auth-server.ts`, Better Auth configuration
- `email.ts`, nodemailer + MJML (Svelte component templates in `src/lib/components/mailTemplates/`)
- `logging.ts`, Pino logger (browser logs POST to `/log`)
- `metrics.ts`, Prometheus via prom-client (exposed at `/metrics`)
- `serverenv.ts`, Zod-validated environment variables

### Path Aliases

Configured in `svelte.config.js`:
- `common-db` → `../common-db/src/`
- `xinity-infoserver` → `../xinity-infoserver/`
- `$lib` → `src/lib/` (SvelteKit default)

## Key Patterns

- oRPC procedures: define input with Zod, chain middleware (`withAuth`/`withOrganization`/`requirePermission`), implement handler
- UI permission gating: check permissions client-side via `permissions.svelte.ts` before showing controls
- `updateOptimistically()` in `src/lib/util.ts` for optimistic UI updates with server rollback
- Environment config validated with Zod in `src/lib/server/serverenv.ts`, add new env vars there
