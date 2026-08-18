# TLS: Encrypted Inference Backend Communication

xinity supports optional TLS between the gateway and inference daemons. When enabled, inference traffic is encrypted in transit. Authentication between services is handled automatically via per-node tokens: the daemon sends its token to the tether at registration, and the gateway reads it from the database when routing requests.

## Architecture

```
Gateway --HTTP(S)--> Daemon (:4044) /proxy/{model}/v1/... --plain HTTP--> Backend on 127.0.0.1
Daemon  --HTTP(S)--> Tether (:4020) /api/v1/stream, /api/v1/status
```

- The daemon acts as a reverse proxy for all inference traffic on its existing HTTP(S) port
- The tether is typically reached by daemons directly rather than through a reverse proxy, and it carries `TETHER_SECRET` as a bearer token. Enabling TLS on it is still possible, and recommended for any untrusted network. 
- Inference backends (vLLM, Ollama) bind to `127.0.0.1` only and are not directly reachable from the network
- Each daemon generates a random auth token on startup and sends it to the tether as part of its registration. The tether writes it to the database, and the gateway reads it automatically
- When TLS is configured on a daemon, it reports this to the tether so the gateway connects via HTTPS

## Security layers

1. **App-level auth**: Each daemon generates a per-instance token on startup and sends it to the tether, which stores it in the database. The gateway reads the token and sends it with every request. No manual configuration needed.
2. **TLS** (opt-in): Encrypts traffic between gateway and daemons. Configure with cert/key env vars.
3. **Overlay networks** (recommended): For production deployments, use an overlay network like WireGuard, Tailscale, or Headscale to isolate service-to-service traffic at the network level.

## Quickstart with self-signed certs

Generate a CA + server certificate using the bundled script:

```bash
./scripts/generate-tls-certs.sh ./certs
```

To add extra SANs (additional IPs or hostnames the daemon listens on):

```bash
./scripts/generate-tls-certs.sh ./certs 10.0.0.5 daemon.internal
```

This creates:

| File | Description | Used by |
|------|-------------|---------|
| `ca.pem` | CA certificate | Gateway (`XINITY_INFERENCE_CA`) |
| `ca-key.pem` | CA private key | Keep secure, only for signing new certs |
| `server.pem` | Server certificate | Daemon (`XINITY_TLS_CERT`) |
| `server-key.pem` | Server private key | Daemon (`XINITY_TLS_KEY`) |

## Environment variable reference

### Server TLS (any service)

These env vars are shared across daemon, gateway, and tether. When both are set, the service serves HTTPS.

| Variable | Description |
|----------|-------------|
| `XINITY_TLS_CERT` | PEM-encoded TLS certificate. Enables HTTPS. |
| `XINITY_TLS_KEY` | PEM-encoded TLS private key. Required with `XINITY_TLS_CERT`. |

All variables support the `_FILE` suffix (e.g., `XINITY_TLS_CERT_FILE=/path/to/cert.pem`).

### Gateway inference connection

| Variable | Description |
|----------|-------------|
| `XINITY_INFERENCE_CA` | PEM-encoded CA certificate for verifying daemon TLS. Only needed for self-signed or private CA certs. For publicly trusted certs, the system trust store is sufficient. |

### Authentication

No configuration needed. Each daemon generates a random token on startup and stores it in the `ai_node.auth_token` database column. The gateway reads it per-node when routing inference requests.

## Deployment

### Docker Compose

Mount certificate files as volumes and use `_FILE` env vars:

```yaml
services:
  daemon:
    environment:
      XINITY_TLS_CERT_FILE: /run/secrets/server-cert
      XINITY_TLS_KEY_FILE: /run/secrets/server-key
    volumes:
      - ./certs/server.pem:/run/secrets/server-cert:ro
      - ./certs/server-key.pem:/run/secrets/server-key:ro

  gateway:
    environment:
      XINITY_INFERENCE_CA_FILE: /run/secrets/ca
    volumes:
      - ./certs/ca.pem:/run/secrets/ca:ro
```

### NixOS

(We always recommend using agenix or nixsops for secrets such as these)

**Daemon** (systemd service, uses LoadCredential):

```nix
services.xinity-ai-daemon = {
  enable = true;
  tlsCertFile = "/run/secrets/xinity/server.pem";
  tlsKeyFile = "/run/secrets/xinity/server-key.pem";
};
```

**Tether** (systemd service, uses LoadCredential):

```nix
services.xinity-tether = {
  enable = true;
  tlsCertFile = "/run/secrets/xinity/tether.pem";
  tlsKeyFile = "/run/secrets/xinity/tether-key.pem";
};
```

With the `allinone` module, set `services.xinity-ai.tether.tlsCertFile` and `tlsKeyFile` instead. The bundled local daemon then dials the tether by domain name rather than loopback, since one certificate cannot be valid for both `127.0.0.1` and a public name.

The certificate must be valid for the name in each node's `TETHER_URL`. If a private CA signed it, the daemons need to trust that CA, which is a trust store concern rather than a Xinity setting:

```nix
services.xinity-ai-daemon.extraEnvironment.NODE_EXTRA_CA_CERTS = "/run/secrets/xinity/ca.pem";
```

**Gateway** (OCI container, uses volume mounts):

```nix
services.xinity-ai-gateway = {
  enable = true;
  inferenceCaFile = "/run/secrets/xinity/ca.pem";
  # Optional: enable HTTPS on the gateway itself
  # tlsCertFile = "/run/secrets/xinity/gateway.pem";
  # tlsKeyFile = "/run/secrets/xinity/gateway-key.pem";
};
```

### systemd (manual)

Use `_FILE` env vars in your environment file:

```ini
XINITY_TLS_CERT_FILE=/etc/xinity/certs/server.pem
XINITY_TLS_KEY_FILE=/etc/xinity/certs/server-key.pem
```

## Bring your own PKI

If you have an existing PKI:

1. Issue a server certificate for each daemon node with appropriate SANs (the node's IP/hostname)
2. If using a private CA, provide the CA cert to the gateway via `XINITY_INFERENCE_CA`
3. If using a publicly trusted CA, no gateway-side configuration is needed

Requirements:
- Server certificate must have `extendedKeyUsage = serverAuth`
- PEM format, EC or RSA keys supported

## Overlay networks

For production deployments where services span multiple hosts, consider using an overlay network:

- **Headscale**: Self-hosted, open-source implementation of the Tailscale control server. Recommended for clients who prefer to host their own infrastructure rather than depend on Tailscale's cloud service.
- **Tailscale**: WireGuard-based mesh VPN with automatic key management.
- **WireGuard**: Lightweight kernel-level VPN. Encrypt all traffic between nodes at the network layer.

An overlay network provides network-level isolation and encryption independently of application-level TLS. The two approaches complement each other and can be used together.

