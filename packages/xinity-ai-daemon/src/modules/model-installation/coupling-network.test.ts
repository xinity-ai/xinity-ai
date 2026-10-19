import { describe, expect, test } from "bun:test";
import { memberGroupFrom } from "./coupling-network";

const local = [
  { subnet: "192.168.101.0/24", address: "192.168.101.2", interface: "enP2p1s0f0np0", rdmaDevice: "roceP2p1s0f0" },
  { subnet: "192.168.100.0/24", address: "192.168.100.2", interface: "enp1s0f0np0", rdmaDevice: "rocep1s0f0" },
];
const group = {
  id: "group-1", rank: 1, size: 2, rendezvousPort: 29501, generation: 1, members: [],
  addresses: [{ subnet: "192.168.100.0/24", address: "192.168.100.253" }, { subnet: "192.168.101.0/24", address: "192.168.101.253" }],
  masterAddresses: [{ subnet: "192.168.100.0/24", address: "192.168.100.254" }, { subnet: "192.168.101.0/24", address: "192.168.101.254" }],
  masterHost: { machineName: "asus-7", addresses: [] },
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
    expect(() => memberGroupFrom(group, local.slice(0, 1))).toThrow("This machine has no coupled port on 192.168.100.0/24");
  });
});
