import { describe, expect, test } from "bun:test";
import { linkedSubnets, memberGroupFrom } from "./coupling-network";

const local = [
  { subnet: "192.168.101.0/24", address: "192.168.101.2", interface: "enP2p1s0f0np0", rdmaDevice: "roceP2p1s0f0" },
  { subnet: "192.168.100.0/24", address: "192.168.100.2", interface: "enp1s0f0np0", rdmaDevice: "rocep1s0f0" },
];
const group = {
  id: "group-1", rank: 1, size: 2, rendezvousPort: 29501, generation: 1, members: [],
  addresses: [{ subnet: "192.168.100.0/24", address: "192.168.100.253" }, { subnet: "192.168.101.0/24", address: "192.168.101.253" }],
  masterAddress: "192.168.100.254",
  masterHost: { machineName: "asus-7", address: null },
};

describe("memberGroupFrom", () => {
  test("runs each assigned address on this machine's interface for its subnet, meeting rank 0 on the first", () => {
    expect(memberGroupFrom(group, local)).toEqual({
      kind: "member", size: 2, rank: 1, masterAddr: "192.168.100.254", masterPort: 29501,
      paths: [
        { subnet: "192.168.100.0/24", address: "192.168.100.253", interface: "enp1s0f0np0", rdmaDevice: "rocep1s0f0" },
        { subnet: "192.168.101.0/24", address: "192.168.101.253", interface: "enP2p1s0f0np0", rdmaDevice: "roceP2p1s0f0" },
      ],
    });
  });

  test("refuses a group on a subnet this machine has no coupled port on", () => {
    expect(() => memberGroupFrom(group, local.slice(0, 1))).toThrow("No coupled port on 192.168.100.0/24");
  });
});

describe("linkedSubnets", () => {
  const port = (carrier: boolean, neighbours: string[]) => ({
    networkCard: "cx7", port: "p0", neighbours,
    paths: [{ interface: "enp1s0f0np0", mac: "aa", carrier, mtu: 9000, speedMbps: 200000, linkLayer: "Ethernet", ipv4: ["192.168.100.2/24"], roceV2Ipv4: ["192.168.100.2"], addressLosses: 0 }],
  });

  test("keeps a subnet while its port has a link, even when the machine at the other end missed a discovery round", () => {
    expect([...linkedSubnets([port(true, ["peer"])])]).toEqual(["192.168.100.0/24"]);
    expect([...linkedSubnets([port(true, [])])]).toEqual(["192.168.100.0/24"]);
  });

  test("drops a subnet once its port has lost the link", () => {
    expect([...linkedSubnets([port(false, [])])]).toEqual([]);
  });
});
