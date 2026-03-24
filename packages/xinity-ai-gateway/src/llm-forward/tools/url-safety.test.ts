import { describe, test, expect, mock } from "bun:test";

mock.module("../../env", () => ({
  env: {
    LOG_LEVEL: "silent",
    LOG_DIR: undefined,
  },
}));

const { validateUrl } = await import("./url-safety");

// ---------------------------------------------------------------------------
// Protocol validation
// ---------------------------------------------------------------------------

describe("validateUrl -protocol", () => {
  test("allows http", () => {
    expect(validateUrl("http://example.com")).toBeNull();
  });

  test("allows https", () => {
    expect(validateUrl("https://example.com")).toBeNull();
  });

  test("blocks ftp", () => {
    expect(validateUrl("ftp://example.com")).toContain("Blocked protocol");
  });

  test("blocks file", () => {
    expect(validateUrl("file:///etc/passwd")).toContain("Blocked protocol");
  });

  test("blocks javascript", () => {
    expect(validateUrl("javascript:alert(1)")).toContain("Blocked protocol");
  });

  test("blocks data URIs", () => {
    expect(validateUrl("data:text/html,<h1>hi</h1>")).toContain("Blocked protocol");
  });
});

// ---------------------------------------------------------------------------
// Invalid URLs
// ---------------------------------------------------------------------------

describe("validateUrl -invalid input", () => {
  test("rejects empty string", () => {
    expect(validateUrl("")).toBe("Invalid URL");
  });

  test("rejects garbage", () => {
    expect(validateUrl("not a url")).toBe("Invalid URL");
  });

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

  test("blocks localhost with port", () => {
    expect(validateUrl("http://localhost:8080/path")).toContain("Blocked hostname");
  });

  test("blocks metadata.google.internal", () => {
    expect(validateUrl("http://metadata.google.internal")).toContain("Blocked hostname");
  });

  test("blocks metadata.google", () => {
    expect(validateUrl("http://metadata.google")).toContain("Blocked hostname");
  });

  test("blocks .internal suffix", () => {
    expect(validateUrl("http://something.internal")).toContain("Blocked hostname");
  });

  test("blocks .local suffix", () => {
    expect(validateUrl("http://myservice.local")).toContain("Blocked hostname");
  });

  test("blocks .localhost suffix", () => {
    expect(validateUrl("http://app.localhost")).toContain("Blocked hostname");
  });
});

// ---------------------------------------------------------------------------
// IPv6 blocking
// ---------------------------------------------------------------------------

describe("validateUrl -IPv6", () => {
  test("blocks IPv6 loopback [::1]", () => {
    expect(validateUrl("http://[::1]/")).toContain("IPv6");
  });

  test("blocks IPv6 mapped IPv4 [::ffff:127.0.0.1]", () => {
    expect(validateUrl("http://[::ffff:127.0.0.1]/")).toContain("IPv6");
  });

  test("blocks arbitrary IPv6 address", () => {
    expect(validateUrl("http://[2001:db8::1]/")).toContain("IPv6");
  });
});

// ---------------------------------------------------------------------------
// Blocked IPv4 ranges
// ---------------------------------------------------------------------------

describe("validateUrl -blocked IP ranges", () => {
  test("blocks 127.0.0.1 (loopback)", () => {
    expect(validateUrl("http://127.0.0.1")).toContain("Blocked IP range");
  });

  test("blocks 127.255.255.255 (loopback)", () => {
    expect(validateUrl("http://127.255.255.255")).toContain("Blocked IP range");
  });

  test("blocks 10.0.0.1 (Class A private)", () => {
    expect(validateUrl("http://10.0.0.1")).toContain("Blocked IP range");
  });

  test("blocks 10.255.255.255 (Class A private)", () => {
    expect(validateUrl("http://10.255.255.255")).toContain("Blocked IP range");
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

  test("blocks 192.168.255.255 (Class C private)", () => {
    expect(validateUrl("http://192.168.255.255")).toContain("Blocked IP range");
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

  test("blocks 240.0.0.1 (reserved)", () => {
    expect(validateUrl("http://240.0.0.1")).toContain("Blocked IP range");
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

  test("allows domain with path and query", () => {
    expect(validateUrl("https://api.example.com/v1/data?key=value")).toBeNull();
  });

  test("allows domain with port", () => {
    expect(validateUrl("https://example.com:8443/path")).toBeNull();
  });
});
