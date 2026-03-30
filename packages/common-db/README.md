# common-db

Shared database schema, migrations, and tooling for the monorepo.

## Requirements

- Bun >= 1.3
- Docker Compose services running (Postgres from `docker compose up -d` at repo root)
- Root `.env` configured (see `example.env`)

## Migrations

From this directory:

```bash
bun run migrate
```

To generate new migrations after editing schema:

```bash
bun run migrate:gen
```

To open Drizzle Studio:

```bash
bun run inspect
```
