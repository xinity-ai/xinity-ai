import { describe, expect, test } from "bun:test";
import { deriveInterconnectOverview, freeMemberAddress, inSubnet, rdmaEndpoints, sharedRdmaSubnets, type CouplingNode } from "./node-coupling";
import type { InterconnectPath, InterconnectPort } from "./tether-protocol";

function path(mac: string, ipv4: string | null, overrides: Partial<InterconnectPath> = {}): InterconnectPath {
  return {
    interface: `if-${mac.slice(-2)}`,
    mac,
    carrier: true,
    mtu: 9000,
    speedMbps: 200000,
    linkLayer: "Ethernet",
    ipv4: ipv4 ? [ipv4] : [],
    roceV2Ipv4: ipv4 ? [ipv4.split("/")[0]!] : [],
    addressLosses: 0,
    ...overrides,
  };
}

function port(name: string, paths: InterconnectPath[], neighbours: string[]): InterconnectPort {
  return { networkCard: "card", port: name, paths, neighbours };
}

// The GX10 pair as measured: port p0 cabled on both PCIe paths, one /24 per path, p1 empty.
const ubuntu: CouplingNode = {
  id: "ubuntu",
  interconnect: [
    port("p0", [path("d6:15", "192.168.100.1/24"), path("d6:19", "192.168.101.1/24")], ["a9:39", "a9:3d"]),
    port("p1", [path("d6:16", null, { carrier: false, speedMbps: null })], []),
  ],
};
const nixos: CouplingNode = {
  id: "nixos",
  interconnect: [
    port("p0", [path("a9:39", "192.168.100.2/24"), path("a9:3d", "192.168.101.2/24")], ["d6:15", "d6:19"]),
    port("p1", [path("a9:3a", null, { carrier: false, speedMbps: null })], []),
  ],
};

describe("deriveInterconnectOverview", () => {
  test("couples the two machines on the cable, and finds nothing wrong with a healthy link", () => {
    const { couplings, portIssues } = deriveInterconnectOverview([ubuntu, nixos]);
    expect(couplings).toEqual([
      {
        nodeIds: ["nixos", "ubuntu"],
        members: [
          { nodeId: "ubuntu", networkCard: "card", port: "p0" },
          { nodeId: "nixos", networkCard: "card", port: "p0" },
        ],
        issues: [],
        viable: true,
      },
    ]);
    expect(portIssues).toEqual([]);
  });

  test("finds the rdma path through the first pcie path pair that shares a subnet", () => {
    expect(rdmaEndpoints(ubuntu.interconnect[0]!, nixos.interconnect[0]!)).toEqual([
      { interface: "if-15", ipv4: "192.168.100.1" },
      { interface: "if-39", ipv4: "192.168.100.2" },
    ]);
  });

  test("a node alone is not coupled", () => {
    expect(deriveInterconnectOverview([ubuntu]).couplings).toEqual([]);
  });

  test("gives every cable of a three-machine ring its own coupling", () => {
    const ring: CouplingNode[] = [
      { id: "n1", interconnect: [port("p0", [path("11:00", "10.0.0.1/24")], ["22:01"]), port("p1", [path("11:01", "10.0.2.2/24")], ["33:00"])] },
      { id: "n2", interconnect: [port("p0", [path("22:00", "10.0.1.1/24")], ["33:01"]), port("p1", [path("22:01", "10.0.0.2/24")], ["11:00"])] },
      { id: "n3", interconnect: [port("p0", [path("33:00", "10.0.2.1/24")], ["11:01"]), port("p1", [path("33:01", "10.0.1.2/24")], ["22:00"])] },
    ];
    const couplings = deriveInterconnectOverview(ring).couplings;
    expect(couplings.map((coupling) => coupling.nodeIds).sort()).toEqual([["n1", "n2"], ["n1", "n3"], ["n2", "n3"]]);
    expect(couplings.flatMap((coupling) => coupling.issues)).toEqual([]);
  });

  test("puts every node behind one switch into a single coupling", () => {
    const behindSwitch: CouplingNode[] = ["a", "b", "c"].map((id, i) => ({
      id,
      interconnect: [port("p0", [path(`${id}:00`, `10.1.0.${i + 1}/24`)], ["a:00", "b:00", "c:00"].filter((mac) => mac !== `${id}:00`))],
    }));
    expect(deriveInterconnectOverview(behindSwitch).couplings.map((coupling) => coupling.nodeIds)).toEqual([["a", "b", "c"]]);
  });

  test("flags members that disagree on mtu, or whose addresses share no subnet", () => {
    const left: CouplingNode = { id: "left", interconnect: [port("p0", [path("aa:01", "10.0.0.1/24", { mtu: 1500 })], ["bb:01"])] };
    const right: CouplingNode = { id: "right", interconnect: [port("p0", [path("bb:01", "10.9.9.2/24")], ["aa:01"])] };
    const [coupling] = deriveInterconnectOverview([left, right]).couplings;
    expect(coupling!.viable).toBe(false);
    expect(coupling!.issues).toEqual([
      { kind: "mtu-mismatch", mtus: [1500, 9000] },
      {
        kind: "no-shared-subnet",
        between: [{ nodeId: "left", networkCard: "card", port: "p0" }, { nodeId: "right", networkCard: "card", port: "p0" }],
      },
    ]);
  });

  test("names what is wrong with a port that has a link", () => {
    const troubled: CouplingNode = {
      id: "troubled",
      interconnect: [
        port("p0", [
          path("cc:01", null, { interface: "path-a" }),
          path("cc:02", "10.0.0.1/24", { interface: "path-b", roceV2Ipv4: [], mtu: 1500, addressLosses: 3 }),
        ], ["ff:ff"]),
        port("p1", [path("cc:03", "10.0.1.1/24", { interface: "path-c" })], []),
      ],
    };
    expect(deriveInterconnectOverview([troubled]).portIssues).toEqual([
      {
        port: { nodeId: "troubled", networkCard: "card", port: "p0" },
        issues: [
          { kind: "no-address", interface: "path-a" },
          { kind: "no-rdma-address", interface: "path-b" },
          { kind: "address-keeps-vanishing", interface: "path-b", losses: 3 },
          { kind: "mtu-below-9000", interface: "path-b", mtu: 1500 },
          { kind: "unregistered-neighbour", mac: "ff:ff" },
        ],
      },
      { port: { nodeId: "troubled", networkCard: "card", port: "p1" }, issues: [{ kind: "no-neighbours" }] },
    ]);
  });
});

describe("sharedRdmaSubnets", () => {
  const located = [ubuntu, nixos].flatMap((node) => node.interconnect.map((coupled) => ({ nodeId: node.id, port: coupled })));

  test("lists every subnet both machines reach over the cable, with each one's address there", () => {
    expect(sharedRdmaSubnets(located, ["ubuntu", "nixos"])).toEqual([
      { subnet: "192.168.100.0/24", addresses: { ubuntu: "192.168.100.1", nixos: "192.168.100.2" } },
      { subnet: "192.168.101.0/24", addresses: { ubuntu: "192.168.101.1", nixos: "192.168.101.2" } },
    ]);
  });

  test("leaves out a subnet one of the machines has no rdma address on", () => {
    const halfAddressed = { nodeId: "nixos", port: port("p0", [path("a9:39", "192.168.100.2/24"), path("a9:3d", null)], ["d6:15"]) };
    const ports = [...located.filter((entry) => entry.nodeId === "ubuntu"), halfAddressed];
    expect(sharedRdmaSubnets(ports, ["ubuntu", "nixos"]).map(({ subnet }) => subnet)).toEqual(["192.168.100.0/24"]);
  });
});

describe("freeMemberAddress", () => {
  test("takes the highest address below the broadcast address", () => {
    expect(freeMemberAddress("192.168.100.0/24", new Set(["192.168.100.1", "192.168.100.2"]))).toBe("192.168.100.254");
  });

  test("steps down past addresses already taken", () => {
    expect(freeMemberAddress("192.168.100.0/24", new Set(["192.168.100.254", "192.168.100.253"]))).toBe("192.168.100.252");
  });

  test("finds nothing in a subnet without a free host address", () => {
    expect(freeMemberAddress("10.0.0.0/30", new Set(["10.0.0.1", "10.0.0.2"]))).toBeUndefined();
    expect(freeMemberAddress("10.0.0.4/31", new Set())).toBeUndefined();
  });
});

describe("inSubnet", () => {
  test("holds an address inside the subnet and refuses one outside it", () => {
    expect(inSubnet("192.168.100.254", "192.168.100.0/24")).toBe(true);
    expect(inSubnet("192.168.101.1", "192.168.100.0/24")).toBe(false);
    expect(inSubnet("192.168.101.1", "192.168.100.0/23")).toBe(true);
  });
});
