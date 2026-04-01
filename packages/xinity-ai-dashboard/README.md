# xinity-ai-dashboard

SvelteKit admin dashboard for Xinity AI. Built with Vite + Bun, Tailwind CSS, and a small set of UI and server utilities.

## Requirements

- Bun >= 1.3
- Local dependencies running via `docker compose up -d` at repo root
- `.env` configured in this directory (see `example.env`)

## Stack overview

- SvelteKit app with Bun adapter (`packages/xinity-ai-dashboard/svelte.config.js`)
- Vite dev/build pipeline (`packages/xinity-ai-dashboard/vite.config.ts`)
- Tailwind CSS via the Vite plugin and `src/app.css`
- shadcn-svelte component registry configuration (`packages/xinity-ai-dashboard/components.json`)
- ORPC client/server utilities (`src/lib/orpc`)
- Auth helpers built on better-auth (`src/lib/auth.ts`, `src/lib/server/auth-server.ts`)
- Email support via nodemailer + MJML (`src/lib/server/email.ts`)
- Metrics via prom-client (`src/lib/server/metrics.ts`)

## Development

```bash
bun run dev
```

## Build and preview

```bash
bun run build
bun run preview
```

## shadcn-svelte components

This repo uses shadcn-svelte for UI components. To add new components:

```bash
bun x shadcn-svelte@latest add button dropdown-menu
```

Docs and component list: https://shadcn-svelte.com/

## Project structure

- `src/routes`: SvelteKit routes, layouts, and endpoints
- `src/lib/components`: UI components (including shadcn-svelte generated ones)
- `src/lib/server`: server-only modules (auth, email, metrics, logging)
- `src/lib/orpc`: ORPC client/server configuration
- `src/lib/state`: shared stores and state helpers
- `src/lib/assets`: local assets imported by the app
- `src/params`: custom route param matchers
- `static`: static assets served as-is

## Testing

```bash
bun run test            # all dashboard tests
bun run test:api        # API tests only
bun run test:headed     # browser tests with visible browser
bun run test:setup      # run test setup (user/org creation) standalone
```

The dashboard tests require a running application and its dependencies. Before running tests locally:

1. Start local dependencies from the repo root:
   ```bash
   docker compose up -d
   cd packages/common-db && bun run migrate
   ```

2. Start the infoserver:
   ```bash
   cd packages/xinity-infoserver && bun run dev
   ```

3. Build and run the dashboard:
   ```bash
   cd packages/xinity-ai-dashboard
   cp example.env .env    # if not already configured
   bun run build
   bun run preview
   ```

The tests expect the dashboard at `http://localhost:5173`. On first run, the test setup automatically creates test users and organizations via the API.

## License

This package is licensed under the **Elastic License 2.0 (ELv2)**, which differs from the Apache 2.0 license used by the rest of the monorepo. See the [LICENSE](./LICENSE) file in this directory for the full terms.

## Notes

- Mailhog UI runs at `http://localhost:8025` when the dev Docker stack is up.
- `MODEL_CONFIG_URL` points at `http://localhost:8090/models/v1.yaml` in the dev Docker stack.
