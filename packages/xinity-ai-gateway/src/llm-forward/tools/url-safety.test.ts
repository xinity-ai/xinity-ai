import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LookupAddress } from "node:dns";

const resolved: Record<string, LookupAddress[]> = {};
mock.module("node:dns/promises", () => ({
  lookup: async (hostname: string) => {
    const addresses = resolved[hostname];
    if (!addresses) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    }
    return addresses;
  },
}));

const { validateUrl, resolvePublicAddresses, fetchPinned } = await import("./url-safety");

async function blockedReason(hostname: string): Promise<string | null> {
  const resolved = await resolvePublicAddresses(hostname);
  return "blocked" in resolved ? resolved.blocked : null;
}

// ---------------------------------------------------------------------------
// Protocol validation
// ---------------------------------------------------------------------------

describe("validateUrl -protocol", () => {
  // Everything outside the http/https allowlist takes the same single branch.
  test("blocks javascript", () => {
    expect(validateUrl("javascript:alert(1)")).toContain("Blocked protocol");
  });
});

// ---------------------------------------------------------------------------
// Invalid URLs
// ---------------------------------------------------------------------------

describe("validateUrl -invalid input", () => {
  test("rejects missing protocol", () => {
    expect(validateUrl("example.com/path")).toBe("Invalid URL");
  });
});

// ---------------------------------------------------------------------------
// Blocked hostnames
// ---------------------------------------------------------------------------

describe("validateUrl -blocked hostnames", () => {
  test("blocks localhost", () => {
    expect(validateUrl("http://localhost")).toContain("Blocked hostname");
  });

  test("blocks metadata.google.internal", () => {
    expect(validateUrl("http://metadata.google.internal")).toContain("Blocked hostname");
  });

  // .local and .localhost run through the same endsWith check.
  test("blocks .internal suffix", () => {
    expect(validateUrl("http://something.internal")).toContain("Blocked hostname");
  });
});

// ---------------------------------------------------------------------------
// IPv6 blocking
// ---------------------------------------------------------------------------

describe("validateUrl -IPv6", () => {
  // Every IPv6 form is rejected by the same colon check.
  test("blocks IPv6 mapped IPv4 [::ffff:127.0.0.1]", () => {
    expect(validateUrl("http://[::ffff:127.0.0.1]/")).toContain("IPv6");
  });
});

// ---------------------------------------------------------------------------
// Resolved IPv6 addresses
// ---------------------------------------------------------------------------

describe("resolvePublicAddresses -IPv6", () => {
  const blocked: [string, string][] = [
    ["unspecified", "::"],
    ["loopback", "::1"],
    ["unique-local", "fd12:3456::1"],
    ["link-local outside fe80::/16", "febf::1"],
    ["site-local", "fec0::1"],
    ["multicast", "ff02::1"],
    ["IPv4-mapped loopback, dotted", "::ffff:127.0.0.1"],
    ["IPv4-mapped loopback, hex", "::ffff:7f00:1"],
    ["IPv4-mapped metadata, uncompressed", "0:0:0:0:0:ffff:a9fe:a9fe"],
    ["NAT64 of a private address", "64:ff9b::a00:1"],
  ];

  for (const [name, address] of blocked) {
    test(`blocks ${name} (${address})`, async () => {
      const hostname = `${name.replaceAll(/[^a-z0-9]+/g, "-")}.test`;
      resolved[hostname] = [{ address, family: 6 }];
      expect(await blockedReason(hostname)).not.toBeNull();
    });
  }

  // NAT64 is how IPv6-only hosts reach public IPv4, so only the embedded address decides.
  test("allows NAT64 of a public address (64:ff9b::808:808)", async () => {
    resolved["nat64-public.test"] = [{ address: "64:ff9b::808:808", family: 6 }];
    expect(await blockedReason("nat64-public.test")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Resolver outcomes
// ---------------------------------------------------------------------------

describe("resolvePublicAddresses -resolver outcomes", () => {
  test("blocks a hostname the resolver cannot find", async () => {
    expect(await blockedReason("missing.test")).toContain("Could not resolve");
  });

  test("blocks a hostname that resolves to no addresses", async () => {
    resolved["empty.test"] = [];
    expect(await blockedReason("empty.test")).toContain("no addresses");
  });

  test("blocks when any one of several addresses is private", async () => {
    resolved["mixed.test"] = [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.5", family: 4 }];
    expect(await blockedReason("mixed.test")).toContain("Blocked IP range");
  });

  test("allows a hostname with only public addresses", async () => {
    resolved["public.test"] = [{ address: "93.184.215.14", family: 4 }, { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 }];
    expect(await blockedReason("public.test")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Blocked IPv4 ranges
// ---------------------------------------------------------------------------

describe("validateUrl -blocked IP ranges", () => {
  test("blocks 127.0.0.1 (loopback)", () => {
    expect(validateUrl("http://127.0.0.1")).toContain("Blocked IP range");
  });

  test("blocks 10.0.0.1 (Class A private)", () => {
    expect(validateUrl("http://10.0.0.1")).toContain("Blocked IP range");
  });

  test("blocks 172.16.0.1 (Class B private)", () => {
    expect(validateUrl("http://172.16.0.1")).toContain("Blocked IP range");
  });

  test("blocks 172.31.255.255 (Class B private upper bound)", () => {
    expect(validateUrl("http://172.31.255.255")).toContain("Blocked IP range");
  });

  test("allows 172.15.0.1 (just below private range)", () => {
    expect(validateUrl("http://172.15.0.1")).toBeNull();
  });

  test("allows 172.32.0.1 (just above private range)", () => {
    expect(validateUrl("http://172.32.0.1")).toBeNull();
  });

  test("blocks 192.168.0.1 (Class C private)", () => {
    expect(validateUrl("http://192.168.0.1")).toContain("Blocked IP range");
  });

  test("blocks 169.254.169.254 (link-local / cloud metadata)", () => {
    expect(validateUrl("http://169.254.169.254")).toContain("Blocked IP range");
  });

  test("blocks 0.0.0.0 (current network)", () => {
    expect(validateUrl("http://0.0.0.0")).toContain("Blocked IP range");
  });

  test("blocks 100.64.0.1 (carrier-grade NAT)", () => {
    expect(validateUrl("http://100.64.0.1")).toContain("Blocked IP range");
  });

  test("blocks 100.127.255.255 (carrier-grade NAT upper bound)", () => {
    expect(validateUrl("http://100.127.255.255")).toContain("Blocked IP range");
  });

  test("allows 100.63.255.255 (just below CGNAT)", () => {
    expect(validateUrl("http://100.63.255.255")).toBeNull();
  });

  test("allows 100.128.0.1 (just above CGNAT)", () => {
    expect(validateUrl("http://100.128.0.1")).toBeNull();
  });

  test("blocks 198.18.0.1 (benchmarking)", () => {
    expect(validateUrl("http://198.18.0.1")).toContain("Blocked IP range");
  });

  test("blocks 198.19.255.255 (benchmarking)", () => {
    expect(validateUrl("http://198.19.255.255")).toContain("Blocked IP range");
  });

  test("blocks 192.0.0.1 (IETF protocol assignments)", () => {
    expect(validateUrl("http://192.0.0.1")).toContain("Blocked IP range");
  });

  test("blocks 192.0.2.1 (TEST-NET-1)", () => {
    expect(validateUrl("http://192.0.2.1")).toContain("Blocked IP range");
  });

  test("blocks 198.51.100.1 (TEST-NET-2)", () => {
    expect(validateUrl("http://198.51.100.1")).toContain("Blocked IP range");
  });

  test("blocks 203.0.113.1 (TEST-NET-3)", () => {
    expect(validateUrl("http://203.0.113.1")).toContain("Blocked IP range");
  });

  test("blocks 224.0.0.1 (multicast)", () => {
    expect(validateUrl("http://224.0.0.1")).toContain("Blocked IP range");
  });

  test("blocks 239.255.255.250 (multicast upper part)", () => {
    expect(validateUrl("http://239.255.255.250")).toContain("Blocked IP range");
  });

  test("blocks 240.0.0.1 (reserved)", () => {
    expect(validateUrl("http://240.0.0.1")).toContain("Blocked IP range");
  });

  test("blocks 250.1.2.3 (reserved upper part)", () => {
    expect(validateUrl("http://250.1.2.3")).toContain("Blocked IP range");
  });

  // The URL parser turns these into 127.0.0.1 before the range check sees them.
  test("blocks decimal and hex spellings of loopback", () => {
    expect(validateUrl("http://2130706433/")).toContain("Blocked IP range");
    expect(validateUrl("http://0x7f.0.0.1/")).toContain("Blocked IP range");
  });

  test("blocks 255.255.255.255 (broadcast)", () => {
    expect(validateUrl("http://255.255.255.255")).toContain("Blocked IP range");
  });
});

// ---------------------------------------------------------------------------
// Safe URLs
// ---------------------------------------------------------------------------

describe("validateUrl -safe URLs", () => {
  test("allows normal public domain", () => {
    expect(validateUrl("https://example.com")).toBeNull();
  });

  test("allows public IP", () => {
    expect(validateUrl("http://8.8.8.8")).toBeNull();
  });

});

// ---------------------------------------------------------------------------
// Pinned fetch
// ---------------------------------------------------------------------------

const LOOPBACK: LookupAddress = { address: "127.0.0.1", family: 4 };

function echoRequest(req: Request): Response {
  const { pathname, search } = new URL(req.url);
  return Response.json({ host: req.headers.get("host"), path: pathname + search });
}

describe("fetchPinned", () => {
  test("connects to the pinned address and keeps the hostname in the Host header", async () => {
    using server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: echoRequest });
    const res = await fetchPinned(new URL(`http://pinned.test:${server.port}/page?q=1`), LOOPBACK, {});
    expect(await res.json()).toEqual({ host: `pinned.test:${server.port}`, path: "/page?q=1" });
  });

  const openssl = Bun.which("openssl");

  describe.skipIf(!openssl)("over TLS", () => {
    const certDir = mkdtempSync(join(tmpdir(), "url-safety-tls-"));
    let cert: string;
    let key: string;

    beforeAll(async () => {
      await $`${openssl!} req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=pinned.test -addext subjectAltName=DNS:pinned.test -keyout ${join(certDir, "key.pem")} -out ${join(certDir, "cert.pem")}`.quiet();
      cert = await Bun.file(join(certDir, "cert.pem")).text();
      key = await Bun.file(join(certDir, "key.pem")).text();
    });

    afterAll(() => rmSync(certDir, { recursive: true, force: true }));

    test("checks the certificate against the hostname, not the pinned address", async () => {
      using server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert, key }, fetch: echoRequest });
      const res = await fetchPinned(new URL(`https://pinned.test:${server.port}/`), LOOPBACK, { tls: { ca: cert } });
      expect(await res.json()).toEqual({ host: `pinned.test:${server.port}`, path: "/" });
    });

    test("rejects a certificate issued for a different hostname", async () => {
      using server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert, key }, fetch: echoRequest });
      await expect(fetchPinned(new URL(`https://other.test:${server.port}/`), LOOPBACK, { tls: { ca: cert } })).rejects.toThrow();
    });
  });
});
