import { describe, expect, mock, test } from "bun:test";

mock.module("./db", () => ({ getDB: () => ({}) }));

const { masterHostOn } = await import("./group-peer-host");

const path = (iface: string, ipv4: string) => ({
  interface: iface, mac: `mac-${iface}`, carrier: true, mtu: 9000, speedMbps: 200000, linkLayer: "Ethernet",
  ipv4: [ipv4], roceV2Ipv4: [ipv4.split("/")[0]!], addressLosses: 0,
});
const group = { id: "group-1", rank: 0, size: 2, parallelism: "tensor" as const, rendezvousPort: 29500, generation: 1, addresses: [{ subnet: "192.168.100.0/24", address: "192.168.100.254" }] };

describe("masterHostOn", () => {
  test("gives rank 0's own address on the group's subnets, leaving out its other coupled paths", () => {
    const interconnect = [{ networkCard: "cx7", port: "p0", paths: [path("enp1s0f0np0", "192.168.100.1/24"), path("enP2p1s0f0np0", "192.168.101.1/24")], neighbours: ["peer"] }];
    expect(masterHostOn(group, { machineName: "asus-7", host: "192.0.2.7", interconnect })).toEqual({
      machineName: "asus-7",
      addresses: [{ subnet: "192.168.100.0/24", address: "192.168.100.1" }],
    });
    expect(masterHostOn(group, { machineName: null, host: "192.0.2.7", interconnect: [] })).toEqual({ machineName: "192.0.2.7", addresses: [] });
  });
});
