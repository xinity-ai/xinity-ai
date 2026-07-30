# Reverse proxy configuration

The gateway expects to sit behind a reverse proxy that terminates TLS. These are the configurations for doing that.

| File | Notes |
|---|---|
| [`Caddyfile`](Caddyfile) | Mounted directly by the [Docker Compose deployment](../docker/README.md). Upstreams are Compose service names, so adjust them for other environments. |
| [`nginx.conf`](nginx.conf) | Template. Replace every `CHANGEME` and copy the blocks into your nginx configuration. |

On NixOS the `allinone` module configures Caddy for you; see [`nix/modules/xinity-ai-allinone.mod.nix`](../../nix/modules/xinity-ai-allinone.mod.nix).

Read [docs/security/reverse-proxy.md](../../docs/security/reverse-proxy.md) before adapting either file. Several common proxy defaults break streaming, uploads, and long generations, and the reasoning behind each setting lives there rather than being duplicated in both configs.
