import { z } from "zod";
import type { InterconnectPath, InterconnectPort } from "./tether-protocol";

export type CouplingNode = { id: string; interconnect: InterconnectPort[] };

const portRefSchema = z.object({ nodeId: z.string(), networkCard: z.string(), port: z.string() });
export type PortRef = z.infer<typeof portRefSchema>;

const portIssueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no-address"), interface: z.string() }),
  z.object({ kind: z.literal("no-rdma-address"), interface: z.string() }),
  z.object({ kind: z.literal("address-keeps-vanishing"), interface: z.string(), losses: z.number() }),
  z.object({ kind: z.literal("mtu-below-9000"), interface: z.string(), mtu: z.number() }),
  z.object({ kind: z.literal("no-neighbours") }),
  z.object({ kind: z.literal("unregistered-neighbour"), mac: z.string() }),
]);
export type PortIssue = z.infer<typeof portIssueSchema>;

const couplingIssueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mtu-mismatch"), mtus: z.array(z.number()) }),
  z.object({ kind: z.literal("speed-mismatch"), speedsMbps: z.array(z.number()) }),
  z.object({ kind: z.literal("no-shared-subnet"), between: z.tuple([portRefSchema, portRefSchema]) }),
]);
export type CouplingIssue = z.infer<typeof couplingIssueSchema>;

const couplingSchema = z.object({
  nodeIds: z.array(z.string()),
  members: z.array(portRefSchema),
  issues: z.array(couplingIssueSchema),
  // Every pair of members has an RDMA path, so a model could be served across the coupling
  viable: z.boolean(),
});
export type Coupling = z.infer<typeof couplingSchema>;

export const interconnectOverviewSchema = z.object({
  couplings: z.array(couplingSchema),
  portIssues: z.array(z.object({ port: portRefSchema, issues: z.array(portIssueSchema) })),
});
export type InterconnectOverview = z.infer<typeof interconnectOverviewSchema>;

const RDMA_MTU = 9000;

type LocatedPort = { ref: PortRef; port: InterconnectPort };

type AddressedPort = { paths: readonly Pick<InterconnectPath, "interface" | "carrier" | "ipv4" | "roceV2Ipv4">[] };

const livePaths = <Port extends AddressedPort>(port: Port): Port["paths"] => port.paths.filter((path) => path.carrier);
const distinct = <T>(values: T[]) => [...new Set(values)].sort();

function pathIssues(path: InterconnectPath): PortIssue[] {
  const issues: PortIssue[] = [];
  if (path.ipv4.length === 0) {
    issues.push({ kind: "no-address", interface: path.interface });
  } else if (path.roceV2Ipv4.length === 0) {
    issues.push({ kind: "no-rdma-address", interface: path.interface });
  }
  if (path.addressLosses > 0) {
    issues.push({ kind: "address-keeps-vanishing", interface: path.interface, losses: path.addressLosses });
  }
  if (path.mtu < RDMA_MTU) {
    issues.push({ kind: "mtu-below-9000", interface: path.interface, mtu: path.mtu });
  }
  return issues;
}

function portIssues(port: InterconnectPort, registeredMacs: ReadonlySet<string>): PortIssue[] {
  const live = livePaths(port);
  if (live.length === 0) {
    return [];
  }
  const unregistered = port.neighbours.filter((mac) => !registeredMacs.has(mac));
  return [
    ...live.flatMap(pathIssues),
    ...(port.neighbours.length === 0 ? [{ kind: "no-neighbours" } as const] : []),
    ...unregistered.map((mac) => ({ kind: "unregistered-neighbour", mac }) as const),
  ];
}

type Subnet = { network: number; prefix: number };

function parseCidr(cidr: string): (Subnet & { address: string }) | null {
  const [address, prefixText] = cidr.split("/");
  const octets = address?.split(".").map(Number) ?? [];
  const prefix = Number(prefixText);
  if (octets.length !== 4 || !Number.isInteger(prefix)) {
    return null;
  }
  const value = octets.reduce((acc, octet) => (acc << 8) | octet, 0) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { address: address!, network: (value & mask) >>> 0, prefix };
}

export type RdmaEndpoint = { interface: string; ipv4: string };

function rdmaAddresses(port: AddressedPort): (Subnet & { endpoint: RdmaEndpoint })[] {
  return livePaths(port).flatMap((path) =>
    path.ipv4.flatMap((cidr) => {
      const subnet = parseCidr(cidr);
      return subnet && path.roceV2Ipv4.includes(subnet.address)
        ? [{ ...subnet, endpoint: { interface: path.interface, ipv4: subnet.address } }]
        : [];
    }),
  );
}

// The first pair of paths, one per port, whose RDMA-usable addresses share a subnet.
export function rdmaEndpoints(a: InterconnectPort, b: InterconnectPort): [RdmaEndpoint, RdmaEndpoint] | null {
  const theirs = rdmaAddresses(b);
  for (const mine of rdmaAddresses(a)) {
    const match = theirs.find((other) => other.network === mine.network && other.prefix === mine.prefix);
    if (match) {
      return [mine.endpoint, match.endpoint];
    }
  }
  return null;
}

function couplingIssues(members: LocatedPort[]): CouplingIssue[] {
  const issues: CouplingIssue[] = [];
  const paths = members.flatMap(({ port }) => livePaths(port));
  const mtus = distinct(paths.map((path) => path.mtu));
  if (mtus.length > 1) {
    issues.push({ kind: "mtu-mismatch", mtus });
  }
  const speeds = distinct(paths.flatMap((path) => (path.speedMbps === null ? [] : [path.speedMbps])));
  if (speeds.length > 1) {
    issues.push({ kind: "speed-mismatch", speedsMbps: speeds });
  }
  for (const [i, a] of members.entries()) {
    for (const b of members.slice(i + 1)) {
      if (a.ref.nodeId !== b.ref.nodeId && !rdmaEndpoints(a.port, b.port)) {
        issues.push({ kind: "no-shared-subnet", between: [a.ref, b.ref] });
      }
    }
  }
  return issues;
}

// Ports that see each other's MACs share a segment. Following those links joins every port on one
// segment, so a direct cable yields two nodes and a switch yields all nodes behind it.
function segments(ports: LocatedPort[]): LocatedPort[][] {
  const portByMac = new Map<string, number>();
  ports.forEach(({ port }, index) => {
    for (const path of port.paths) {
      portByMac.set(path.mac, index);
    }
  });

  const segmentOf = ports.map((_, index) => index);
  const root = (index: number): number => {
    while (segmentOf[index] !== index) {
      index = segmentOf[index]!;
    }
    return index;
  };
  ports.forEach(({ port }, index) => {
    for (const mac of port.neighbours) {
      const other = portByMac.get(mac);
      if (other !== undefined) {
        segmentOf[root(other)] = root(index);
      }
    }
  });

  const grouped = new Map<number, LocatedPort[]>();
  ports.forEach((located, index) => {
    grouped.set(root(index), [...(grouped.get(root(index)) ?? []), located]);
  });
  return [...grouped.values()];
}

const formatIpv4 = (value: number) => [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");

export type RdmaPath = { subnet: string; address: string; interface: string };

export function rdmaPathsOf(port: AddressedPort): RdmaPath[] {
  return rdmaAddresses(port).map(({ network, prefix, endpoint }) => ({
    // Named by network address and prefix, so two nodes' different addresses on one subnet name it alike.
    subnet: `${formatIpv4(network)}/${prefix}`,
    address: endpoint.ipv4,
    interface: endpoint.interface,
  }));
}

export function inSubnet(address: string, subnet: string): boolean {
  const ofAddress = parseCidr(`${address}/${subnet.split("/")[1]}`);
  const ofSubnet = parseCidr(subnet);
  return ofAddress !== null && ofSubnet !== null && ofAddress.network === ofSubnet.network;
}

export type SharedSubnet = { subnet: string; addresses: Record<string, string> };

export function sharedRdmaSubnets(ports: readonly { nodeId: string; port: InterconnectPort }[], nodeIds: readonly string[]): SharedSubnet[] {
  const byNode = nodeIds.map((nodeId) => {
    const subnets = new Map<string, string>();
    for (const { port } of ports.filter((located) => located.nodeId === nodeId)) {
      for (const { subnet, address } of rdmaPathsOf(port)) {
        // A node with several paths on one subnet still gets one address there, the first one found.
        if (!subnets.has(subnet)) {
          subnets.set(subnet, address);
        }
      }
    }
    return { nodeId, subnets };
  });
  const [first, ...rest] = byNode;
  // Any subnet missing on one node is no use to the group, so the first node's subnets are cut down to those every other node has too.
  return [...(first?.subnets.keys() ?? [])]
    .filter((subnet) => rest.every(({ subnets }) => subnets.has(subnet)))
    .map((subnet) => ({ subnet, addresses: Object.fromEntries(byNode.map(({ nodeId, subnets }) => [nodeId, subnets.get(subnet)!])) }));
}

export function freeMemberAddress(subnet: string, taken: ReadonlySet<string>): string | undefined {
  const parsed = parseCidr(subnet);
  // A /31 or /32 has no address left over besides the ones that name the network itself.
  if (!parsed || parsed.prefix > 30) {
    return undefined;
  }
  // All host bits set gives the broadcast address. The final >>> 0 keeps the result an unsigned 32-bit number,
  // since JavaScript's | returns a signed one.
  const broadcast = (parsed.network | (0xffffffff >>> parsed.prefix)) >>> 0;
  // From just below the broadcast address down to just above the network address, both of which no host may use.
  // Starting at the top keeps members away from the port addresses operators usually assign from the bottom.
  for (let value = broadcast - 1; value > parsed.network; value--) {
    const address = formatIpv4(value);
    if (!taken.has(address)) {
      return address;
    }
  }
  return undefined;
}

export function deriveInterconnectOverview(nodes: readonly CouplingNode[]): InterconnectOverview {
  const ports: LocatedPort[] = nodes.flatMap((node) =>
    node.interconnect.map((port) => ({ ref: { nodeId: node.id, networkCard: port.networkCard, port: port.port }, port })),
  );
  const registeredMacs = new Set(ports.flatMap(({ port }) => port.paths.map((path) => path.mac)));

  const couplings = segments(ports).flatMap((members) => {
    const nodeIds = distinct(members.map(({ ref }) => ref.nodeId));
    if (nodeIds.length < 2) {
      return [];
    }
    const issues = couplingIssues(members);
    const viable = !issues.some((issue) => issue.kind === "no-shared-subnet");
    return [{ nodeIds, members: members.map(({ ref }) => ref), issues, viable }];
  });

  return {
    couplings,
    portIssues: ports.flatMap(({ ref, port }) => {
      const issues = portIssues(port, registeredMacs);
      return issues.length > 0 ? [{ port: ref, issues }] : [];
    }),
  };
}

// Anchors of the troubleshooting headings in docs/features/node-coupling.md
export type CouplingDocsSection =
  | "no-ipv4-address"
  | "address-rdma-cannot-use"
  | "address-keeps-vanishing"
  | "mtu-below-9000"
  | "no-machine-answers"
  | "machine-without-the-xinity-daemon"
  | "different-mtus"
  | "different-speeds"
  | "no-common-subnet"
  | "rdma-core-missing"
  | "test-connection-blocked"
  | "rdma-transfer-failed";

export const couplingDocsUrl = (section: CouplingDocsSection) =>
  `https://github.com/xinity-ai/xinity-ai/blob/main/docs/features/node-coupling.md#${section}`;

export type IssueDescription = { text: string; docsUrl: string };

type IssueGuide<Issue extends { kind: string }> = {
  [Kind in Issue["kind"]]: { text: (issue: Extract<Issue, { kind: Kind }>) => string; docs: CouplingDocsSection };
};

const PORT_ISSUE_GUIDE: IssueGuide<PortIssue> = {
  "no-address": { text: (issue) => `${issue.interface} has no IPv4 address`, docs: "no-ipv4-address" },
  "no-rdma-address": { text: (issue) => `${issue.interface} has an address RDMA cannot use`, docs: "address-rdma-cannot-use" },
  "address-keeps-vanishing": {
    text: (issue) => `${issue.interface} lost its address ${issue.losses === 1 ? "once" : `${issue.losses} times`} since the daemon started`,
    docs: "address-keeps-vanishing",
  },
  "mtu-below-9000": { text: (issue) => `${issue.interface} runs at MTU ${issue.mtu}, RDMA needs 9000 for full speed`, docs: "mtu-below-9000" },
  "no-neighbours": { text: () => "cable in, but no machine answers on it", docs: "no-machine-answers" },
  "unregistered-neighbour": {
    text: (issue) => `a machine without the Xinity daemon answers (${issue.mac})`,
    docs: "machine-without-the-xinity-daemon",
  },
};

const COUPLING_ISSUE_GUIDE: IssueGuide<CouplingIssue> = {
  "mtu-mismatch": { text: (issue) => `coupled ports use different MTUs (${issue.mtus.join(", ")})`, docs: "different-mtus" },
  "speed-mismatch": {
    text: (issue) => `coupled ports link at different speeds (${issue.speedsMbps.map((mbps) => `${mbps / 1000} Gb/s`).join(", ")})`,
    docs: "different-speeds",
  },
  "no-shared-subnet": { text: () => "coupled ports have no IPv4 subnet in common", docs: "no-common-subnet" },
};

function describe<Issue extends { kind: string }>(guides: IssueGuide<Issue>, issue: Issue): IssueDescription {
  const guide = guides[issue.kind as Issue["kind"]] as { text: (issue: Issue) => string; docs: CouplingDocsSection };
  return { text: guide.text(issue), docsUrl: couplingDocsUrl(guide.docs) };
}

export const describePortIssue = (issue: PortIssue) => describe(PORT_ISSUE_GUIDE, issue);
export const describeCouplingIssue = (issue: CouplingIssue) => describe(COUPLING_ISSUE_GUIDE, issue);
