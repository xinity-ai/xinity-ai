import { describe, expect, test } from "bun:test";
import { couplingDocsUrl } from "common-env/node-coupling";
import { interconnectOfNode } from "../src/lib/compute/format";

const ref = (nodeId: string) => ({ nodeId, networkCard: "card", port: "p0" });
const names = new Map([["a", "spark-a"], ["b", "spark-b"], ["c", "spark-c"]]);
const nameOf = (id: string) => names.get(id) ?? id;

describe("interconnectOfNode", () => {
  test("names each peer once and words the node's own and its couplings' issues with their docs", () => {
    const overview = {
      couplings: [
        { nodeIds: ["a", "b"], members: [ref("a"), ref("b")], issues: [{ kind: "mtu-mismatch" as const, mtus: [1500, 9000] }], viable: true },
        { nodeIds: ["a", "c"], members: [ref("a"), ref("c")], issues: [], viable: true },
        { nodeIds: ["b", "c"], members: [ref("b"), ref("c")], issues: [], viable: true },
      ],
      portIssues: [
        { port: ref("a"), issues: [{ kind: "mtu-below-9000" as const, interface: "enp1s0f0np0", mtu: 1500 }] },
        { port: ref("b"), issues: [{ kind: "no-neighbours" as const }] },
      ],
    };
    expect(interconnectOfNode(overview, "a", nameOf)).toEqual({
      coupledWith: ["spark-b", "spark-c"],
      issues: [
        { text: "p0: enp1s0f0np0 runs at MTU 1500, RDMA needs 9000 for full speed", docsUrl: couplingDocsUrl("mtu-below-9000") },
        { text: "coupled ports use different MTUs (1500, 9000)", docsUrl: couplingDocsUrl("different-mtus") },
      ],
    });
  });

  test("an uncoupled node without issues shows nothing", () => {
    expect(interconnectOfNode({ couplings: [], portIssues: [] }, "a", nameOf)).toEqual({ coupledWith: [], issues: [] });
  });
});
