import { couplingDocsUrl, type RdmaEndpoint } from "common-env";
import { commandExistsOn, type Host } from "../core/host.ts";
import type { CheckResult } from "./doctor-probes.ts";

export type RdmaTestSide = { name: string; host: Host; endpoint: RdmaEndpoint };

type RdmaDevice = { device: string; port: string; gidIndex: string };

const PINGPONG = "ibv_rc_pingpong";
const HANDSHAKE_PORT = 18515;
const TRANSFER_ARGS = ["-s", "1048576", "-n", "200"];

function ipv4MappedGid(ipv4: string): string {
  const hex = ipv4.split(".").map((octet) => Number(octet).toString(16).padStart(2, "0"));
  return `0000:0000:0000:0000:0000:ffff:${hex[0]}${hex[1]}:${hex[2]}${hex[3]}`;
}

// RDMA device names differ between distributions, so the device and GID index behind an
// interface and address are looked up on the host every time.
async function findRdmaDevice(side: RdmaTestSide): Promise<RdmaDevice | null> {
  if (!/^[\w.:-]+$/.test(side.endpoint.interface)) {
    return null;
  }
  const result = await side.host.runShell([
    `dev=$(ls /sys/class/net/${side.endpoint.interface}/device/infiniband 2>/dev/null | head -n1)`,
    `[ -n "$dev" ] || exit 1`,
    `for p in /sys/class/infiniband/$dev/ports/*; do for g in $p/gids/*; do i=\${g##*/};`,
    `[ "$(cat $g 2>/dev/null)" = "${ipv4MappedGid(side.endpoint.ipv4)}" ] &&`,
    `[ "$(cat $p/gid_attrs/types/$i 2>/dev/null)" = "RoCE v2" ] && { echo "$dev \${p##*/} $i"; exit 0; };`,
    `done; done; exit 1`,
  ].join("\n"));
  const [device, port, gidIndex] = result.ok ? result.output.trim().split(" ") : [];
  return device && port && gidIndex ? { device, port, gidIndex } : null;
}

const pingpongArgs = ({ device, port, gidIndex }: RdmaDevice) => ["-d", device, "-i", port, "-g", gidIndex, ...TRANSFER_ARGS];

// The handshake goes through the kernel's network stack and a host firewall can block it, while
// RDMA traffic itself bypasses the kernel. So only a failure after the handshake is an RDMA failure.
export async function testRdmaPath(server: RdmaTestSide, client: RdmaTestSide): Promise<CheckResult> {
  const label = `RDMA ${server.name} · ${client.name}`;
  for (const side of [server, client]) {
    if (!(await commandExistsOn(side.host, PINGPONG))) {
      return { label, status: "warn", message: `${PINGPONG} not found on ${side.name}, install rdma-core to test the link (${couplingDocsUrl("rdma-core-missing")})` };
    }
  }
  const [serverDevice, clientDevice] = await Promise.all([findRdmaDevice(server), findRdmaDevice(client)]);
  if (!serverDevice || !clientDevice) {
    const side = serverDevice ? client : server;
    return { label, status: "fail", message: `${side.endpoint.interface} on ${side.name} no longer has an RDMA address for ${side.endpoint.ipv4} (${couplingDocsUrl("address-keeps-vanishing")})` };
  }

  const serverRun = server.host.run(["timeout", "30", PINGPONG, ...pingpongArgs(serverDevice)]);
  await Bun.sleep(1000);
  const clientRun = await client.host.run(["timeout", "20", PINGPONG, ...pingpongArgs(clientDevice), server.endpoint.ipv4]);
  await serverRun;

  if (!clientRun.output.includes("remote address")) {
    return {
      label,
      status: "warn",
      message: `could not reach ${server.endpoint.ipv4} on TCP ${HANDSHAKE_PORT} to set up the test, likely a firewall (${couplingDocsUrl("test-connection-blocked")})`,
      detail: clientRun.output,
    };
  }
  if (!clientRun.output.includes("bytes in")) {
    return { label, status: "fail", message: `the RDMA transfer failed although the link looks usable (${couplingDocsUrl("rdma-transfer-failed")})`, detail: clientRun.output };
  }
  return { label, status: "pass", message: "RDMA transfer works" };
}
