import { $ } from "bun";
import { networkInterfaces } from "node:os";
import { readdir, readFile, realpath } from "node:fs/promises";
import type { InterconnectPath, InterconnectPort } from "common-env";

type DetectedPath = Omit<InterconnectPath, "addressLosses">;
type DetectedPort = Omit<InterconnectPort, "paths"> & { paths: DetectedPath[] };
type CandidatePath = Omit<DetectedPath, "ipv4"> & { networkCard: string; port: string };

async function readSysfs(path: string): Promise<string | null> {
  return readFile(path, "utf-8").then((text) => text.trim(), () => null);
}

async function listDir(path: string): Promise<string[]> {
  return readdir(path).catch(() => []);
}

export async function rdmaDevicesOf(netdevs: readonly string[], sysfs = "/sys"): Promise<string[]> {
  const devices = await Promise.all(netdevs.map(async (netdev) => (await listDir(`${sysfs}/class/net/${netdev}/device/infiniband`))[0]));
  return [...new Set(devices.filter((device) => device !== undefined))];
}

export function ipv4FromGid(gid: string): string | null {
  const match = gid.match(/^0000:0000:0000:0000:0000:ffff:([0-9a-f]{2})([0-9a-f]{2}):([0-9a-f]{2})([0-9a-f]{2})$/i);
  return match ? match.slice(1).map((byte) => Number.parseInt(byte, 16)).join(".") : null;
}

type RdmaPortFacts = { linkLayer: string | null; roceV2Ipv4: string[] };

async function readRdmaPort(sysfs: string, rdmaDevice: string, netdev: string): Promise<RdmaPortFacts> {
  const portsDir = `${sysfs}/class/infiniband/${rdmaDevice}/ports`;
  for (const port of await listDir(portsDir)) {
    const portDir = `${portsDir}/${port}`;
    const roceV2Ipv4: string[] = [];
    let servesNetdev = false;
    for (const index of await listDir(`${portDir}/gid_attrs/ndevs`)) {
      if ((await readSysfs(`${portDir}/gid_attrs/ndevs/${index}`)) !== netdev) {
        continue;
      }
      servesNetdev = true;
      const [type, gid] = await Promise.all([
        readSysfs(`${portDir}/gid_attrs/types/${index}`),
        readSysfs(`${portDir}/gids/${index}`),
      ]);
      const ipv4 = gid ? ipv4FromGid(gid) : null;
      if (type === "RoCE v2" && ipv4) {
        roceV2Ipv4.push(ipv4);
      }
    }
    if (servesNetdev) {
      return { linkLayer: await readSysfs(`${portDir}/link_layer`), roceV2Ipv4 };
    }
  }
  return { linkLayer: null, roceV2Ipv4: [] };
}

// Only RDMA-capable ports qualify, since NCCL over plain TCP is far too slow for tensor parallel.
// A network card that exposes no switch id is keyed by its PCI address, so each function counts as one.
async function readCandidatePath(sysfs: string, netdev: string): Promise<CandidatePath | null> {
  const netDir = `${sysfs}/class/net/${netdev}`;
  const [rdmaDevice] = await listDir(`${netDir}/device/infiniband`);
  if (!rdmaDevice) {
    return null;
  }
  const [mac, carrier, mtu, speed, switchId, portName, pciPath, rdmaPort] = await Promise.all([
    readSysfs(`${netDir}/address`),
    readSysfs(`${netDir}/carrier`),
    readSysfs(`${netDir}/mtu`),
    readSysfs(`${netDir}/speed`),
    readSysfs(`${netDir}/phys_switch_id`),
    readSysfs(`${netDir}/phys_port_name`),
    realpath(`${netDir}/device`).catch(() => null),
    readRdmaPort(sysfs, rdmaDevice, netdev),
  ]);
  const speedMbps = Number(speed);
  return {
    networkCard: switchId || pciPath?.split("/").pop() || netdev,
    port: portName || netdev,
    interface: netdev,
    mac: mac ?? "",
    carrier: carrier === "1",
    mtu: Number(mtu) || 0,
    speedMbps: speedMbps > 0 ? speedMbps : null,
    ...rdmaPort,
  };
}

export async function readCandidatePaths(sysfs = "/sys"): Promise<CandidatePath[]> {
  const netdevs = await listDir(`${sysfs}/class/net`);
  const paths = await Promise.all(netdevs.map((netdev) => readCandidatePath(sysfs, netdev)));
  return paths.filter((path) => path !== null);
}

export async function readLocalMacs(sysfs = "/sys"): Promise<Set<string>> {
  const netdevs = await listDir(`${sysfs}/class/net`);
  const macs = await Promise.all(netdevs.map((netdev) => readSysfs(`${sysfs}/class/net/${netdev}/address`)));
  return new Set(macs.filter((mac) => mac !== null));
}

function ipv4ByInterface(): Map<string, string[]> {
  return new Map(
    Object.entries(networkInterfaces()).map(([name, addresses]) => [
      name,
      (addresses ?? []).flatMap((address) => (address.family === "IPv4" && address.cidr ? [address.cidr] : [])),
    ]),
  );
}

type NeighbourEntry = { dst?: string; lladdr?: string };

const PING_REPLY_SOURCE = /^\d+ bytes from ([0-9a-f:]+)(?:%\S+)?:/gim;

export function neighbourMacsAnswering(pingOutput: string, ipJson: string): string[] {
  // The kernel keeps entries for machines long gone, so only addresses that answered this ping count.
  const answered = new Set([...pingOutput.matchAll(PING_REPLY_SOURCE)].map((match) => match[1]!.toLowerCase()));
  const entries = JSON.parse(ipJson || "[]") as NeighbourEntry[];
  return [...new Set(entries.flatMap((entry) => (entry.lladdr && entry.dst && answered.has(entry.dst.toLowerCase()) ? [entry.lladdr] : [])))];
}

// Every node on the segment answers the IPv6 all-nodes address, so this finds peers without
// knowing their addresses. It needs the port to keep its link-local address.
async function discoverNeighbourMacs(netdev: string): Promise<string[]> {
  const ping = await $`ping -6 -n -i 1 -w 2 ff02::1%${netdev}`.quiet().nothrow().text();
  return neighbourMacsAnswering(ping, await $`ip -j neigh show dev ${netdev}`.nothrow().text());
}

// A network card can expose one physical port on several PCIe paths that share a segment, so a
// node hears its own other paths, and those are dropped along with every other local MAC.
export function groupIntoPorts(
  paths: readonly (CandidatePath & { ipv4: string[] })[],
  neighboursByInterface: ReadonlyMap<string, string[]>,
  localMacs: ReadonlySet<string>,
): DetectedPort[] {
  const ports = new Map<string, DetectedPort>();
  for (const { networkCard, port, ...path } of paths) {
    const key = `${networkCard}/${port}`;
    const entry = ports.get(key) ?? { networkCard, port, paths: [], neighbours: [] };
    entry.paths.push(path);
    const remote = (neighboursByInterface.get(path.interface) ?? []).filter((mac) => !localMacs.has(mac));
    entry.neighbours = [...new Set([...entry.neighbours, ...remote])].sort();
    ports.set(key, entry);
  }
  return [...ports.values()];
}

export async function detectInterconnect(): Promise<DetectedPort[]> {
  const candidates = await readCandidatePaths();
  if (candidates.length === 0) {
    return [];
  }
  const ipv4 = ipv4ByInterface();
  const paths = candidates.map((candidate) => ({ ...candidate, ipv4: ipv4.get(candidate.interface) ?? [] }));
  const neighbours = new Map(
    await Promise.all(
      paths
        .filter((path) => path.carrier)
        .map(async (path) => [path.interface, await discoverNeighbourMacs(path.interface)] as const),
    ),
  );
  return groupIntoPorts(paths, neighbours, await readLocalMacs());
}

export function createInterconnectMonitor(detect: () => Promise<DetectedPort[]> = detectInterconnect) {
  const addressLosses = new Map<string, number>();
  const pathsWithAddress = new Set<string>();

  // Network managers remove a port's address when its cable is pulled, which is not a loss.
  function countLoss(path: DetectedPath): number {
    const hasAddress = path.ipv4.length > 0;
    if (!hasAddress && path.carrier && pathsWithAddress.has(path.interface)) {
      addressLosses.set(path.interface, (addressLosses.get(path.interface) ?? 0) + 1);
    }
    if (hasAddress) {
      pathsWithAddress.add(path.interface);
    } else {
      pathsWithAddress.delete(path.interface);
    }
    return addressLosses.get(path.interface) ?? 0;
  }

  return async function check(): Promise<InterconnectPort[]> {
    const ports = await detect();
    return ports.map((port) => ({
      ...port,
      paths: port.paths.map((path) => ({ ...path, addressLosses: countLoss(path) })),
    }));
  };
}
