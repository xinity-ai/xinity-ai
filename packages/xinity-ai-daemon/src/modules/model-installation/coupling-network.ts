import { $ } from "bun";
import { existsSync } from "node:fs";
import { rdmaPathsOf, type DesiredGroup } from "common-env";
import { detectInterconnect, rdmaDevicesOf } from "../interconnect-detect";
import type { CoupledPath, NodeGroup } from "./vllm-ops";

export async function addressInUse(address: string): Promise<boolean> {
  if ((await $`ping -c 1 -W 1 ${address}`.quiet().nothrow()).exitCode === 0) {
    return true;
  }
  // The ping makes the kernel ask for the address over ARP first, which any holder answers even when it drops ICMP.
  const neighbour = await $`ip neigh show ${address}`.quiet().nothrow().text();
  return /lladdr/.test(neighbour) && !/FAILED|INCOMPLETE/.test(neighbour);
}

export async function runsGroupMembers(backend: "docker" | "systemd"): Promise<boolean> {
  if (!existsSync("/dev/infiniband")) {
    return false;
  }
  if (backend === "systemd") {
    return true;
  }
  // Rootless Docker cannot create the ipvlan networks a member joins.
  const info = await $`docker info --format {{.SecurityOptions}}`.quiet().nothrow();
  return info.exitCode === 0 && !info.text().includes("rootless");
}

export async function coupledPaths(): Promise<CoupledPath[]> {
  const ports = (await detectInterconnect()).filter((port) => port.neighbours.length > 0);
  const withDevices = await Promise.all(ports.flatMap(rdmaPathsOf).map(async (path) => ({ path, rdmaDevice: (await rdmaDevicesOf([path.interface]))[0] })));
  return withDevices.flatMap(({ path, rdmaDevice }) => (rdmaDevice ? [{ ...path, rdmaDevice }] : []));
}

export function memberGroupFrom(group: DesiredGroup, localPaths: CoupledPath[]): NodeGroup {
  const paths = group.addresses.map(({ subnet, address }) => {
    const local = localPaths.find((path) => path.subnet === subnet);
    if (!local) {
      throw new Error(`This machine has no coupled port on ${subnet}`);
    }
    return { ...local, address };
  });
  return { kind: "member", size: group.size, rank: group.rank, masterAddr: group.masterAddress, masterPort: group.rendezvousPort, paths };
}
