# Running xinity behind a reverse proxy

The gateway speaks plain HTTP (or HTTPS, see [TLS](./tls.md)) and is designed to sit behind a reverse proxy that terminates TLS. This page covers what that proxy has to be configured to do.

Configurations for both nginx and Caddy live in [`deployment/reverse-proxy/`](../../deployment/reverse-proxy/). The Docker Compose deployment mounts the Caddyfile from there directly, and on NixOS the `allinone` module configures Caddy for you.

## Defaults that break the gateway

Three common proxy defaults break features rather than degrade them. If you take nothing else from this page, take these.

**Response buffering breaks streaming.** Every `"stream": true` completion is served as `text/event-stream`. A proxy that buffers proxied responses holds the tokens until the generation finishes, so clients see nothing and then everything. nginx buffers by default; set `proxy_buffering off`.

**A 1 MB body limit rejects images and audio.** Multimodal requests carry images inline as base64 data URLs, and `/v1/audio/transcriptions` takes a multipart upload. The gateway accepts images up to 40 MB, which is roughly 54 MB base64-encoded. nginx defaults `client_max_body_size` to 1 MB; allow at least 64 MB.

**A 60 second read timeout truncates long generations.** Reasoning and deep-research requests legitimately run for minutes. Set the proxy's read timeout just above the gateway's own ceilings so the gateway produces the error rather than the proxy cutting the connection: `BACKEND_TIMEOUT_MS` (default 300s) and `IDLE_TIMEOUT` (default 255s).

## Forwarded headers

Set `X-Forwarded-For` and `X-Forwarded-Proto` on every proxied request. The gateway does not currently derive client identity from these headers, so nothing breaks if you omit them, but access logs and any future per-IP policy depend on them.

If you ever configure the gateway to trust forwarded headers, only do so when a proxy you control is the sole path to it. `X-Forwarded-For` is client-settable: a gateway reachable directly will believe whatever it is told.

## Do not expose /metrics

`/metrics` serves Prometheus exposition. It is password protected only when `METRICS_AUTH` is set on the gateway, and is **fully public when that variable is unset**. Deny it at the proxy and scrape it over your internal network:

```nginx
location = /metrics {
    deny all;
}
```

## Rate limiting

Rate limiting belongs at the edge, where a flood can be dropped before it costs the application anything. The nginx template configures per-IP request and connection limits with `limit_req` / `limit_conn`.

Two caveats worth knowing before you rely on it:

- **Caddy cannot rate limit out of the box.** The `rate_limit` directive comes from a third-party plugin and needs a custom build via `xcaddy`. Stock Caddy, including the binary used by the Docker and NixOS deployments, has no equivalent.
- **Per-IP limits are weak against IPv6.** A single client typically holds an entire /64 and can rotate addresses within it for free. nginx cannot truncate `$binary_remote_addr` to a prefix, so per-IP buckets are noise reduction, not a guarantee.

Because of both, the gateway does not depend on the proxy for this. It caps how many uncached API-key verifications may run concurrently and sheds the excess with `503` plus `Retry-After`, so a flood of unrecognised keys cannot occupy the database connection pool no matter how it is distributed or what sits in front. Edge rate limiting reduces the load that reaches that cap; it does not replace it.

Tune the limits to your traffic. A single client can legitimately hold several concurrent streams, so a burst allowance that is too tight is indistinguishable from an outage.
