import { describe, test, expect } from "bun:test";
import { buildDaemonServiceDiscovery, type SdNode } from "./prometheus-sd";

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
