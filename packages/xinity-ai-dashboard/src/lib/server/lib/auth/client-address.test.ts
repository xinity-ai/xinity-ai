import { describe, test, expect } from "bun:test";
import { createClientAddressResolver } from "./client-address";

const forwardedFor = (value: string) => new Request("http://dashboard/", { headers: { "x-forwarded-for": value } });

describe("createClientAddressResolver", () => {
  test("uses the socket address when no header is configured", () => {
    const resolve = createClientAddressResolver({ xffDepth: 1, trustedProxies: [] });
    expect(resolve(forwardedFor("203.0.113.9"), "10.0.0.2")).toBe("10.0.0.2");
  });

  test("accepts the header from any source when no proxies are listed", () => {
    const resolve = createClientAddressResolver({ header: "x-forwarded-for", xffDepth: 1, trustedProxies: [] });
    expect(resolve(forwardedFor("203.0.113.9"), "198.51.100.4")).toBe("203.0.113.9");
  });

  test("counts xffDepth proxies from the right", () => {
    const resolve = createClientAddressResolver({ header: "x-forwarded-for", xffDepth: 2, trustedProxies: [] });
    expect(resolve(forwardedFor("6.6.6.6, 203.0.113.9, 10.0.0.3"), "10.0.0.2")).toBe("203.0.113.9");
  });

  test("ignores the header from a source outside the trusted proxies", () => {
    const resolve = createClientAddressResolver({ header: "x-forwarded-for", xffDepth: 1, trustedProxies: ["10.0.0.0/8"] });
    expect(resolve(forwardedFor("203.0.113.9"), "198.51.100.4")).toBe("198.51.100.4");
  });

  test("accepts the header from a trusted proxy, including IPv4-mapped socket addresses", () => {
    const resolve = createClientAddressResolver({ header: "x-forwarded-for", xffDepth: 1, trustedProxies: ["10.0.0.0/8", "2001:db8::1"] });
    expect(resolve(forwardedFor("203.0.113.9"), "10.1.2.3")).toBe("203.0.113.9");
    expect(resolve(forwardedFor("203.0.113.9"), "::ffff:10.1.2.3")).toBe("203.0.113.9");
    expect(resolve(forwardedFor("203.0.113.9"), "2001:db8::1")).toBe("203.0.113.9");
  });

  test("does not trust the header over a unix socket when proxies are listed", () => {
    const resolve = createClientAddressResolver({ header: "x-forwarded-for", xffDepth: 1, trustedProxies: ["10.0.0.0/8"] });
    expect(resolve(forwardedFor("203.0.113.9"), undefined)).toBe("");
  });

  test("reads a single-address header as is", () => {
    const resolve = createClientAddressResolver({ header: "X-Real-IP", xffDepth: 1, trustedProxies: [] });
    const request = new Request("http://dashboard/", { headers: { "x-real-ip": "203.0.113.9" } });
    expect(resolve(request, "10.0.0.2")).toBe("203.0.113.9");
  });

  test("falls back to the socket address when the header is missing", () => {
    const resolve = createClientAddressResolver({ header: "x-forwarded-for", xffDepth: 1, trustedProxies: [] });
    expect(resolve(new Request("http://dashboard/"), "10.0.0.2")).toBe("10.0.0.2");
  });
});
