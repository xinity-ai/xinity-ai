import { describe, test, expect } from "bun:test";
import { buildDaemonServiceDiscovery, scrapeTarget, type SdNode } from "./prometheus-sd";

const node = (over: Partial<SdNode> = {}): SdNode => ({
  id: "11111111-1111-1111-1111-111111111111",
  host: "10.0.0.5",
  port: 4010,
  tls: false,
  machineName: "box-a",
  ...over,
});

describe("buildDaemonServiceDiscovery", () => {
  test("emits one group per node with host:port target", () => {
    const groups = buildDaemonServiceDiscovery([node(), node({ host: "10.0.0.6" })]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.targets).toEqual(["10.0.0.5:4010"]);
    expect(groups[1]!.targets).toEqual(["10.0.0.6:4010"]);
  });

  test("maps tls to the __scheme__ label", () => {
    expect(buildDaemonServiceDiscovery([node({ tls: false })])[0]!.labels["__scheme__"]).toBe("http");
    expect(buildDaemonServiceDiscovery([node({ tls: true })])[0]!.labels["__scheme__"]).toBe("https");
  });

  test("includes node_id and machine_name labels", () => {
    const labels = buildDaemonServiceDiscovery([node({ id: "abc", machineName: "gpu-1" })])[0]!.labels;
    expect(labels["node_id"]).toBe("abc");
    expect(labels["machine_name"]).toBe("gpu-1");
  });

  test("omits machine_name when the node has none", () => {
    const labels = buildDaemonServiceDiscovery([node({ machineName: null })])[0]!.labels;
    expect(labels["machine_name"]).toBeUndefined();
    expect(labels["node_id"]).toBeDefined();
  });

  test("returns an empty array for an empty fleet", () => {
    expect(buildDaemonServiceDiscovery([])).toEqual([]);
  });
});

describe("scrapeTarget", () => {
  test("keeps an explicit port and scheme", () => {
    expect(scrapeTarget("http://localhost:5121")).toEqual({ target: "localhost:5121", scheme: "http" });
    expect(scrapeTarget("https://dash.example.com:8443")).toEqual({ target: "dash.example.com:8443", scheme: "https" });
  });

  test("falls back to 80 for http and 443 for https when no port is given", () => {
    expect(scrapeTarget("http://dash.example.com")).toEqual({ target: "dash.example.com:80", scheme: "http" });
    expect(scrapeTarget("https://dash.example.com")).toEqual({ target: "dash.example.com:443", scheme: "https" });
  });

  test("ignores path, query, and trailing slash", () => {
    expect(scrapeTarget("https://dash.example.com/admin?x=1")).toEqual({ target: "dash.example.com:443", scheme: "https" });
  });
});
