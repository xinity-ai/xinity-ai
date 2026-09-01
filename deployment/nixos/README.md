# Xinity NixOS Deployment

This repository is a Nix flake. Add it to your NixOS configuration to deploy Xinity services declaratively.

All services (gateway, dashboard, infoserver, tether, daemon) run as native `systemd` services. Binaries are pulled from the GitHub Release: JS bundles run via a shared `pkgs.bun` runtime for gateway/daemon/infoserver/tether, and standalone `bun --compile` binaries for dashboard and cli.

## Architecture

A Xinity deployment spans two kinds of NixOS hosts:

- **Control plane**: runs the gateway, dashboard, tether, infoserver, database, an inference daemon, and reverse proxy. 
- **Inference node**: runs the daemon with Ollama and/or vLLM available. Has GPU capacity and manages model installation. Connects to the tether via SSE.

Add inference nodes when you need capacity beyond the control plane host, or turn the local daemon off (`services.xinity-ai.daemon.enable = false`) to keep the control plane free of inference work.

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

The `allinone` module is the easiest way to deploy Xinity on a single host. It configures PostgreSQL, Redis, gateway, dashboard, infoserver, tether, Caddy (automatic HTTPS), and a local inference daemon with Ollama together.

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
TETHER_SECRET=<random 32+ char string>
```

The same value as `TETHER_SECRET` must be given to every inference node (see [Inference Node](#inference-node-daemon-module) below); it is the only credential daemons use to authenticate.

Use a secrets manager (e.g. [agenix](https://github.com/ryantm/agenix) or [sops-nix](https://github.com/Mic92/sops-nix)) to provision this file.

### What Runs, and How to Disable It

Every part of the stack is a toggle, so you can keep the convenience of `allinone` while supplying any individual piece yourself. Set any of these to `false` and that service is not configured at all:

| Toggle | Default | Change it when |
|---|---|---|
| `database.enable` | on | PostgreSQL lives on another host |
| `redis.enable` | on | Redis lives on another host |
| `migrateOnStart` | on | you apply the bundled database's migrations out-of-band |
| `gateway.enable` | on | the gateway runs elsewhere |
| `dashboard.enable` | on | the dashboard runs elsewhere |
| `infoserver.enable` | on | you use a remote model registry |
| `tether.enable` | on | the tether runs elsewhere |
| `daemon.enable` | on | this host should not serve inference |
| `daemon.ollama.enable` | on | you drive vLLM, or Ollama runs elsewhere |
| `caddy.enable` | on | you handle reverse proxying and TLS |
| `searxng.enable` | on | you do not want web-augmented inference |
| `seaweedfs.enable` | off | you want bundled S3-compatible storage |
| `monitoring.enable` | off | you want bundled Prometheus and Grafana |

Disabling a bundled service does not reconfigure its consumers. Point them at your own instance through the matching `services.xinity-ai-*` option, which always wins over what `allinone` sets.

#### Local Inference

The bundled daemon is tethered over loopback and needs no secret of its own beyond the one the tether already has. Ollama defaults to CPU inference on NixOS, so declare your accelerator:

```nix
services.ollama.acceleration = "cuda";  # or "rocm"
```

For a control plane that does no inference itself:

```nix
services.xinity-ai.daemon.enable = false;
```

To drive vLLM instead of Ollama, turn off the bundled Ollama and configure the driver directly:

```nix
services.xinity-ai.daemon.ollama.enable = false;
services.xinity-ai-daemon.vllmDockerImage = "vllm/vllm-openai:latest";
```

#### External Infoserver

```nix
services.xinity-ai = {
  infoserver.enable = false;
  infoserverUrl = "https://sysinfo.xinity.ai";
};
```

The gateway, dashboard, and local daemon all follow `infoserverUrl`, and Caddy stops routing the infoserver subdomain. `infoserver.modelInfoDir` is not needed in this mode.

#### Your Own Reverse Proxy

```nix
services.xinity-ai = {
  caddy.enable = false;
  domain = "example.com";  # still required: it defines the public URLs services advertise
};
```

Nothing is proxied and no ports are opened for you, so forward `dashboard.example.com` and `api.example.com` to the dashboard and gateway ports (5121 and 4121 by default) and open 80/443 yourself. `acmeEmail` is not required in this mode. The dashboard still expects to be reached at `https://<dashboardSubdomain>.<domain>` for auth redirects, so keep those names pointing at it, and forward `x-forwarded-for`.

#### External Database

```nix
services.xinity-ai = {
  database.enable = false;                              # external PostgreSQL
  redis.enable = true;                                  # but keep Redis local
  secrets.dbConnectionUrlFile = "/run/secrets/xinity-db-url";
};
```

**Migrations come with the bundled database, not with an external one.** The internal instance is migrated for you at boot. An external server is yours to manage, so apply migrations however you already manage that database's schema. `migrateOnStart` has no effect when `database.enable = false`.

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
  tetherSecretFile = "/run/secrets/xinity-tether-secret";
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

### Optional: Object Storage

Images sent to multimodal models are kept so the conversation still shows them when it is replayed later. Without object storage the bytes go into PostgreSQL, which works but is not where you want a growing list of images. Turning on the bundled SeaweedFS moves them out:

```nix
services.xinity-ai.seaweedfs.enable = true;
```

The gateway and dashboard are pointed at it, and the bucket is created
before either of them needs it. The bucket name defaults to xinity-media` and is set in one place if you want another:

```nix
services.xinity-ai.seaweedfs.bucket = "my-media";
```

SeaweedFS allows anonymous S3 access by default, and the gateway and dashboard reach it over loopback. The listener itself is not restricted to loopback, so keep the S3 port closed at the firewall.  
To require credentials instead, point it at an S3 config file and give the same keys to its two clients:

```nix
services.xinity-ai = {
  seaweedfs = {
    enable = true;
    s3Config = "/run/secrets/seaweedfs-s3.json";
  };
  secrets = {
    s3AccessKeyIdFile = "/run/secrets/xinity-s3-key-id";
    s3SecretAccessKeyFile = "/run/secrets/xinity-s3-secret";
  };
};
```

#### Using Storage You Already Have

The bundled instance is off unless you asked for it, so configure the two clients directly.  

```nix
services.xinity-ai-gateway = {
  s3Endpoint = "https://s3.example.com";
  s3Bucket = "xinity-media";
  s3Region = "eu-central-1";
  s3AccessKeyIdFile = "/run/secrets/xinity-s3-key-id";
  s3SecretAccessKeyFile = "/run/secrets/xinity-s3-secret";
};
services.xinity-ai-dashboard = {
  s3Endpoint = "https://s3.example.com";
  s3Bucket = "xinity-media";
  s3Region = "eu-central-1";
  s3AccessKeyIdFile = "/run/secrets/xinity-s3-key-id";
  s3SecretAccessKeyFile = "/run/secrets/xinity-s3-secret";
};
```

Both should point at the same bucket: the gateway writes the images and the dashboard reads them back. Some limited writing may happen from the dashboard, during the migration from db to s3 if you have existing state.  
Create the bucket yourself, since nothing does it for storage the stack does not run, and an upload to a missing bucket is logged and dropped rather than failing the request.

### Optional: SearXNG

SearXNG is enabled by default for web-augmented inference. To disable:

```nix
services.xinity-ai.searxng.enable = false;
```

---

## Inference Node: Daemon Module

Deploy this on each machine with GPU capacity **in addition to** the control plane host.

On an `allinone` host the daemon is already there, configured through `services.xinity-ai.daemon` and `services.xinity-ai-daemon`.

An inference node needs Ollama and/or vLLM available on the same machine to actually serve models.

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

`TETHER_SECRET` must be byte-identical to the value the control plane's tether was given. There is one shared secret per deployment, not one per node.

The daemon is a native systemd service (`systemd.services.xinity-ai-daemon`). It connects to the tether via SSE to receive deployment instructions and reports its state back. It has no direct database connection.

### Reaching the Tether

Inference nodes connect to the tether directly on port 4020, which Caddy does not front, so open it on the control plane host:

```nix
services.xinity-ai.tether.openFirewall = true;
```

A single-host deployment does not need this: the bundled daemon reaches the tether over loopback.

`openFirewall` accepts connections from anywhere. To accept them only from your inference nodes, leave it off and write the narrower rule yourself:

```nix
networking.firewall.extraInputRules = ''
  ip saddr { 10.0.0.11, 10.0.0.12 } tcp dport 4020 accept
'';
```

Or scope it to one interface, which is the usual choice when the nodes share a VPN or overlay network (WireGuard, Tailscale, Headscale):

```nix
networking.firewall.interfaces.wg0.allowedTCPPorts = [ 4020 ];
```

To serve nodes over HTTPS, set `services.xinity-ai.tether.tlsCertFile` and `tlsKeyFile`. Caddy's ACME certificates do not cover the tether, so this needs its own certificate, valid for the `<domain>` nodes dial. Nodes then use `TETHER_URL=https://<domain>:4020`, and the bundled daemon follows that name automatically. See [TLS](../../docs/security/tls.md).


---

## Individual Modules

For fine-grained control, import and configure services separately. Available modules:

| Module | Service |
|---|---|
| `nixosModules.gateway` | API gateway (`services.xinity-ai-gateway`) |
| `nixosModules.dashboard` | Admin dashboard (`services.xinity-ai-dashboard`) |
| `nixosModules.infoserver` | Model registry (`services.xinity-infoserver`) |
| `nixosModules.database` | PostgreSQL + Redis (`services.xinity-ai-database`) |
| `nixosModules.db-init` | Schema migrations (`services.xinity-ai-db-init`) |
| `nixosModules.caddy` | Reverse proxy (`services.xinity-ai-caddy`) |
| `nixosModules.tether` | SSE bridge to daemons (`services.xinity-tether`) |
| `nixosModules.daemon` | Daemon / inference node (`services.xinity-ai-daemon`) |
| `nixosModules.searxng` | Metasearch for web-augmented inference (`services.xinity-ai-searxng`) |
| `nixosModules.seaweedfs` | S3-compatible object storage (`services.xinity-ai-seaweedfs`) |
| `nixosModules.monitoring` | Prometheus + Grafana (`services.xinity-ai-monitoring`) |
| `nixosModules.allinone` | All of the above combined, each individually disableable |

Each service module accepts `environmentFiles` (a list of paths) for secrets. See [nix/modules/](../../nix/modules/) for all available options per service.

These are an alternative to `allinone`, for layouts it cannot express such as splitting services across hosts. To keep the bundle but replace or retune one part, use the toggles in [What Runs, and How to Disable It](#what-runs-and-how-to-disable-it) and set `services.xinity-ai-<service>.*` directly, which `allinone` already declares.
