import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterconnectMonitor, groupIntoPorts, ipv4FromGid, neighbourMacsAnswering, rdmaDevicesOf, readCandidatePaths, readLocalMacs } from "./interconnect-detect";

// The Ubuntu GX10 of the test pair: one ConnectX-7, port p0 cabled on both PCIe paths, p1 empty.
const SWITCH_ID = "15d6500003e282b0";

type Netdev = { name: string; mac: string; port: string; rdma?: string; carrier: string; speed: string; gids?: [string, string][] };

const GX10_NETDEVS: Netdev[] = [
  {
    name: "enp1s0f0np0", mac: "b0:82:e2:50:d6:15", port: "p0", rdma: "rocep1s0f0", carrier: "1", speed: "200000",
    gids: [
      ["fe80:0000:0000:0000:b282:e2ff:fe50:d615", "IB/RoCE v1"],
      ["fe80:0000:0000:0000:b282:e2ff:fe50:d615", "RoCE v2"],
      ["0000:0000:0000:0000:0000:ffff:c0a8:6401", "IB/RoCE v1"],
      ["0000:0000:0000:0000:0000:ffff:c0a8:6401", "RoCE v2"],
    ],
  },
  { name: "enp1s0f1np1", mac: "b0:82:e2:50:d6:16", port: "p1", rdma: "rocep1s0f1", carrier: "0", speed: "-1" },
  {
    name: "enP2p1s0f0np0", mac: "b0:82:e2:50:d6:19", port: "p0", rdma: "roceP2p1s0f0", carrier: "1", speed: "200000",
    gids: [["0000:0000:0000:0000:0000:ffff:c0a8:6501", "RoCE v2"]],
  },
  { name: "enP2p1s0f1np1", mac: "b0:82:e2:50:d6:1a", port: "p1", rdma: "roceP2p1s0f1", carrier: "0", speed: "-1" },
  { name: "enP7s7", mac: "4c:bb:47:2a:10:01", port: "", carrier: "1", speed: "10000" },
];

let sysfs: string;

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${content}\n`);
}

beforeAll(async () => {
  sysfs = await mkdtemp(join(tmpdir(), "interconnect-sysfs-"));
  for (const netdev of GX10_NETDEVS) {
    const net = `${sysfs}/class/net/${netdev.name}`;
    await put(`${net}/address`, netdev.mac);
    await put(`${net}/carrier`, netdev.carrier);
    await put(`${net}/speed`, netdev.speed);
    await put(`${net}/mtu`, "1500");
    if (!netdev.rdma) {
      await mkdir(`${net}/device`, { recursive: true });
      continue;
    }
    await put(`${net}/phys_switch_id`, SWITCH_ID);
    await put(`${net}/phys_port_name`, netdev.port);
    await mkdir(`${net}/device/infiniband/${netdev.rdma}`, { recursive: true });
    const port = `${sysfs}/class/infiniband/${netdev.rdma}/ports/1`;
    await put(`${port}/link_layer`, "Ethernet");
    for (const [index, [gid, type]] of (netdev.gids ?? []).entries()) {
      await put(`${port}/gids/${index}`, gid);
      await put(`${port}/gid_attrs/types/${index}`, type);
      await put(`${port}/gid_attrs/ndevs/${index}`, netdev.name);
    }
  }
});

afterAll(async () => {
  await rm(sysfs, { recursive: true, force: true });
});

describe("readCandidatePaths", () => {
  test("takes only rdma-capable ports, with what the network card reports about each", async () => {
    const paths = await readCandidatePaths(sysfs);
    expect(paths.map((path) => path.interface).sort()).toEqual(["enP2p1s0f0np0", "enP2p1s0f1np1", "enp1s0f0np0", "enp1s0f1np1"]);
    expect(paths.find((path) => path.interface === "enp1s0f0np0")).toEqual({
      networkCard: SWITCH_ID,
      port: "p0",
      interface: "enp1s0f0np0",
      mac: "b0:82:e2:50:d6:15",
      carrier: true,
      mtu: 1500,
      speedMbps: 200000,
      linkLayer: "Ethernet",
      roceV2Ipv4: ["192.168.100.1"],
    });
  });

  test("reports an empty port as down with no speed", async () => {
    const empty = (await readCandidatePaths(sysfs)).find((path) => path.interface === "enp1s0f1np1");
    expect(empty).toMatchObject({ carrier: false, speedMbps: null, roceV2Ipv4: [] });
  });
});

describe("rdmaDevicesOf", () => {
  test("names the RDMA device behind each interface once, and skips interfaces without one", async () => {
    expect(await rdmaDevicesOf(["enp1s0f0np0", "enP2p1s0f0np0", "enP7s7", "enp1s0f0np0"], sysfs)).toEqual(["rocep1s0f0", "roceP2p1s0f0"]);
  });
});

describe("groupIntoPorts", () => {
  test("joins a port's pcie paths and keeps only the peer's macs as neighbours", async () => {
    const paths = (await readCandidatePaths(sysfs)).map((path) => ({ ...path, ipv4: [] }));
    const neighbours = new Map([
      ["enp1s0f0np0", ["b0:82:e2:50:a9:3d", "b0:82:e2:50:a9:39", "b0:82:e2:50:d6:19"]],
      ["enP2p1s0f0np0", ["b0:82:e2:50:a9:39", "b0:82:e2:50:d6:15"]],
    ]);
    const ports = groupIntoPorts(paths, neighbours, await readLocalMacs(sysfs));
    expect(ports.map(({ port, paths }) => ({ port, paths: paths.length })).sort((a, b) => a.port.localeCompare(b.port))).toEqual([
      { port: "p0", paths: 2 },
      { port: "p1", paths: 2 },
    ]);
    expect(ports.find((port) => port.port === "p0")!.neighbours).toEqual(["b0:82:e2:50:a9:39", "b0:82:e2:50:a9:3d"]);
  });
});

describe("ipv4FromGid", () => {
  test("reads the address out of an ipv4-mapped gid, and nothing out of a link-local one", () => {
    expect(ipv4FromGid("0000:0000:0000:0000:0000:ffff:c0a8:6401")).toBe("192.168.100.1");
    expect(ipv4FromGid("fe80:0000:0000:0000:b282:e2ff:fe50:d615")).toBeNull();
  });
});

describe("neighbourMacsAnswering", () => {
  test("keeps the machines that answered and drops entries the kernel kept for ones long gone", () => {
    const ping = [
      "PING ff02::1%enp1s0f0np0 (ff02::1%enp1s0f0np0) 56 data bytes",
      "64 bytes from fe80::41e3:a280:6578:3ad5%enp1s0f0np0: icmp_seq=1 ttl=64 time=0.953 ms",
      "64 bytes from fe80::c332:279c:7805:f9de%enp1s0f0np0: icmp_seq=1 ttl=64 time=0.997 ms",
      "64 bytes from fe80::41e3:a280:6578:3ad5%enp1s0f0np0: icmp_seq=2 ttl=64 time=0.912 ms",
    ].join("\n");
    const json = JSON.stringify([
      { dst: "fe80::41e3:a280:6578:3ad5", dev: "enp1s0f0np0", lladdr: "30:c5:99:3d:f4:e6", state: ["STALE"] },
      { dst: "fe80::c332:279c:7805:f9de", dev: "enp1s0f0np0", lladdr: "30:c5:99:3d:f4:ea", state: ["REACHABLE"] },
      { dst: "fe80::1cd2:e7ff:fe2a:1b4c", dev: "enp1s0f0np0", lladdr: "1e:d2:e7:2a:1b:4c", state: ["STALE"] },
      { dst: "192.168.100.2", dev: "enp1s0f0np0", lladdr: "30:c5:99:3d:f4:e6", state: ["REACHABLE"] },
      { dst: "fe80::1", dev: "enp1s0f0np0", state: ["FAILED"] },
    ]);
    expect(neighbourMacsAnswering(ping, json)).toEqual(["30:c5:99:3d:f4:e6", "30:c5:99:3d:f4:ea"]);
    expect(neighbourMacsAnswering("", "")).toEqual([]);
  });
});

describe("createInterconnectMonitor", () => {
  test("counts each time a path loses its last address, across checks", async () => {
    const path = { interface: "enp1s0f0np0", mac: "b0:82:e2:50:d6:15", carrier: true, mtu: 1500, speedMbps: 200000, linkLayer: "Ethernet", roceV2Ipv4: [] };
    const addressSequence = [["192.168.100.1/24"], [], [], ["192.168.100.1/24"], []];
    let call = 0;
    const check = createInterconnectMonitor(async () => [
      { networkCard: SWITCH_ID, port: "p0", neighbours: [], paths: [{ ...path, ipv4: addressSequence[call++]! }] },
    ]);
    const losses = [];
    for (let i = 0; i < addressSequence.length; i++) {
      losses.push((await check())[0]!.paths[0]!.addressLosses);
    }
    expect(losses).toEqual([0, 1, 1, 1, 2]);
  });

  test("an address removed along with the cable is not a loss", async () => {
    const path = { interface: "enp1s0f0np0", mac: "b0:82:e2:50:d6:15", mtu: 1500, speedMbps: 200000, linkLayer: "Ethernet", roceV2Ipv4: [] };
    const sequence = [
      { carrier: true, ipv4: ["192.168.100.1/24"] },
      { carrier: false, ipv4: [] },
      { carrier: true, ipv4: [] },
      { carrier: true, ipv4: ["192.168.100.1/24"] },
    ];
    let call = 0;
    const check = createInterconnectMonitor(async () => [
      { networkCard: SWITCH_ID, port: "p0", neighbours: [], paths: [{ ...path, ...sequence[call++]! }] },
    ]);
    const losses = [];
    for (let i = 0; i < sequence.length; i++) {
      losses.push((await check())[0]!.paths[0]!.addressLosses);
    }
    expect(losses).toEqual([0, 0, 0, 0]);
  });
});
