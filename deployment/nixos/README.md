# Xinity NixOS Deployment

This repository is a Nix flake. Add it to your NixOS configuration to deploy Xinity services declaratively.

All services (gateway, dashboard, infoserver, tether, daemon) run as native `systemd` services. Binaries are pulled from the GitHub Release: JS bundles run via a shared `pkgs.bun` runtime for gateway/daemon/infoserver/tether, and standalone `bun --compile` binaries for dashboard and cli.

## Architecture

A Xinity deployment spans two kinds of NixOS hosts:

- **Control plane**: runs the gateway, dashboard, tether, infoserver, database, and reverse proxy.
- **Inference node**: runs the daemon with Ollama and/or vLLM available. Has GPU capacity and manages model installation. Connects to the tether via SSE.

Each gets a different module.

## Add the Flake Input

```nix
# flake.nix
inputs.xinity-ai.url = "github:xinity-ai/xinity-ai";
```

Binary caches are available to avoid building from source:

```nix
nix.settings = {
  extra-substituters = [ "https://nix-community.cachix.org" ];
  extra-trusted-public-keys = [
    "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
  ];
};
```

---

## Control Plane: All-in-One Module

The `allinone` module is the easiest way to deploy the full control plane on a single host. It configures PostgreSQL, Redis, gateway, dashboard, infoserver, and Caddy (automatic HTTPS) together.

```nix
# In your NixOS host configuration
{ inputs, ... }: {
  imports = [ inputs.xinity-ai.nixosModules.allinone ];

  services.xinity-ai = {
    enable = true;
    domain = "example.com";
    acmeEmail = "admin@example.com";

    # Path to a secrets file, kept outside the Nix store
    environmentFiles = [ "/run/secrets/xinity" ];

    infoserver.modelInfoDir = /etc/xinity/models.d;
  };
}
```

The `environmentFiles` entries must contain at minimum:

```bash
DB_CONNECTION_URL=postgresql://xinity:PASSWORD@localhost/xinity
REDIS_URL=redis://:PASSWORD@localhost:6379
BETTER_AUTH_SECRET=<random 32+ char string>
```

Use a secrets manager (e.g. [agenix](https://github.com/ryantm/agenix) or [sops-nix](https://github.com/Mic92/sops-nix)) to provision this file.

### Secrets: Three Tiers

The modules offer three ways to provide secrets, from simplest to most secure:

**1. Direct values (development only)** — set values in Nix. These end up in the world-readable Nix store. Do NOT use in production.

```nix
services.xinity-ai-gateway.dbConnectionUrl = "postgresql://...";
```

**2. Environment files** — one or more files outside the Nix store, sourced by systemd. Secrets stay off disk in the store but share one file.

```nix
services.xinity-ai.environmentFiles = [ "/run/secrets/xinity" ];
```

**3. Per-secret files with `_FILE` (recommended)** — each secret gets its own file on the host. The service loads them into its runtime credential directory via systemd's `LoadCredential`, and the application reads them at startup; the value never appears as an environment variable.

```nix
services.xinity-ai.secrets = {
  dbConnectionUrlFile = "/run/secrets/xinity-db-url";
  redisUrlFile = "/run/secrets/xinity-redis-url";
  betterAuthSecretFile = "/run/secrets/xinity-auth-secret";
  metricsAuthFile = "/run/secrets/xinity-metrics-auth";
  s3AccessKeyIdFile = "/run/secrets/xinity-s3-key";
  s3SecretAccessKeyFile = "/run/secrets/xinity-s3-secret";
  licenseKeyFile = "/run/secrets/xinity-license";
};
```

**File permissions:** Each host file just needs to be readable by the user the service runs as. The services run as `root` by default (override via `systemd.services.<name>.serviceConfig.User`), so any file readable by root is sufficient. With agenix:

```nix
age.secrets.xinity-db-url = {
  file = ./secrets/db-url.age;
  mode = "0400";
};
```

All three tiers can be mixed. Direct values and `environmentFiles` entries take precedence over `_FILE` variants. For the full list of per-secret options, see the module source in [nix/modules/](../../nix/modules/).

### Subdomains

By default, services are exposed at:

- `dashboard.example.com`
- `api.example.com`
- `sysinfo.example.com`

Override with:

```nix
services.xinity-ai = {
  domain = "example.org";
  dashboardSubdomain = "admin";
  gatewaySubdomain = "gateway";
  infoserverSubdomain = "models";
};
```

### Optional: SearXNG

SearXNG is enabled by default for web-augmented inference. To disable:

```nix
services.xinity-ai.searxng.enable = false;
```

---

## Inference Node: Daemon Module

Deploy this on each machine with GPU capacity. It needs Ollama and/or vLLM available on the same machine to actually serve models.

```nix
{ inputs, ... }: {
  imports = [ inputs.xinity-ai.nixosModules.daemon ];

  # Enable whichever driver(s) this node should run; the daemon
  # manages models through Ollama and/or vLLM independently.
  services.ollama.enable = true;

  services.xinity-ai-daemon = {
    enable = true;
    environmentFiles = [ "/run/secrets/xinity-daemon" ];
  };
}
```

The `environmentFiles` entries must contain:

```bash
TETHER_URL=http://control-plane-host:4020
TETHER_SECRET=<shared-secret>
```

The daemon is a native systemd service (`systemd.services.xinity-ai-daemon`). It connects to the tether via SSE to receive deployment instructions and reports its state back. It has no direct database connection.


---

## Individual Modules

For fine-grained control, import and configure services separately. Available modules:

| Module | Service |
|---|---|
| `nixosModules.gateway` | API gateway (`services.xinity-ai-gateway`) |
| `nixosModules.dashboard` | Admin dashboard (`services.xinity-ai-dashboard`) |
| `nixosModules.infoserver` | Model registry (`services.xinity-infoserver`) |
| `nixosModules.database` | PostgreSQL + Redis (`services.xinity-ai-database`) |
| `nixosModules.caddy` | Reverse proxy (`services.xinity-ai-caddy`) |
| `nixosModules.tether` | SSE bridge to daemons (`services.xinity-tether`) |
| `nixosModules.allinone` | All of the above combined |
| `nixosModules.daemon` | Daemon / inference node (`services.xinity-ai-daemon`) |
| `nixosModules.monitoring` | Prometheus + Grafana (`services.xinity-ai-monitoring`) |

Each service module accepts `environmentFiles` (a list of paths) for secrets. See [nix/modules/](../../nix/modules/) for all available options per service.
