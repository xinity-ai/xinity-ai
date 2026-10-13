import { describe, expect, test } from "bun:test";
import type { Host, RunResult } from "../core/host.ts";
import { testRdmaPath, type RdmaTestSide } from "./rdma-test.ts";

const ADDRESSES = "  local address:  LID 0x0000, QPN 0x00012c, PSN 0x4ce44e, GID ::ffff:192.168.100.2\n  remote address: LID 0x0000, QPN 0x00012a, PSN 0x5c96c7, GID ::ffff:192.168.100.1";

function fakeHost({ hasTool = true, pingpongOutput = "" }: { hasTool?: boolean; pingpongOutput?: string }): Host {
  const result = (ok: boolean, output = ""): RunResult => ({ ok, output, exitCode: ok ? 0 : 1 });
  return {
    runShell: async (command: string) => (command.startsWith("command -v") ? result(hasTool) : result(true, "mlx5_0 1 5")),
    run: async () => result(true, pingpongOutput),
  } as unknown as Host;
}

function sides(client: Host): [RdmaTestSide, RdmaTestSide] {
  return [
    { name: "spark-a", host: fakeHost({}), endpoint: { interface: "enp1s0f0np0", ipv4: "192.168.100.1" } },
    { name: "spark-b", host: client, endpoint: { interface: "enp1s0f0np0", ipv4: "192.168.100.2" } },
  ];
}

describe("testRdmaPath", () => {
  test("passes when the transfer completes", async () => {
    const client = fakeHost({ pingpongOutput: `${ADDRESSES}\n4194304000 bytes in 1.45 seconds = 23177.85 Mbit/sec` });
    expect((await testRdmaPath(...sides(client))).status).toBe("pass");
  });

  test("fails when rdma breaks after the handshake", async () => {
    const client = fakeHost({ pingpongOutput: `${ADDRESSES}\nFailed status transport retry counter exceeded (12) for wr_id 2\nparse WC failed 1` });
    expect((await testRdmaPath(...sides(client))).status).toBe("fail");
  });

  test("only warns when the handshake never gets through, since rdma itself bypasses the firewall", async () => {
    const client = fakeHost({ pingpongOutput: "  local address:  LID 0x0000, QPN 0x000128, PSN 0x9dae1a, GID ::ffff:192.168.100.2" });
    expect((await testRdmaPath(...sides(client))).status).toBe("warn");
  });

  test("only warns when the test tool is missing", async () => {
    const result = await testRdmaPath(...sides(fakeHost({ hasTool: false })));
    expect(result).toMatchObject({ status: "warn", message: expect.stringContaining("rdma-core") });
  });
});
