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

## Notes

- Mailhog UI runs at `http://localhost:8025` when the dev Docker stack is up.
- `MODEL_CONFIG_URL` points at `http://localhost:8090/models/v1.yaml` in the dev Docker stack.
