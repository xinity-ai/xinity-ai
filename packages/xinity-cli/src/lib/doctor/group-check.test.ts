import { describe, expect, mock, test } from "bun:test";
import type { GroupStage } from "common-env";
import type { Host } from "../core/host.ts";
import { checkGroup, type HostedMember } from "./group-check.ts";

const member = (rank: number, stage: GroupStage | null, generation = 1): HostedMember => ({
  hostName: `spark-${rank}`,
  specifier: "qwen3.8-27b",
  stage,
  stageGeneration: stage ? generation : null,
  group: {
    id: "group-1", rank, size: 2, parallelism: "tensor" as const, rendezvousPort: 29500, generation,
    addresses: [{ subnet: "192.168.100.0/24", address: `192.168.100.${254 - rank}` }],
    masterAddress: "192.168.100.254",
    masterHost: { machineName: "spark-0", address: null },
  },
});

const hostAnswering = (exitCode: number) => {
  const run = mock(async (_args: string[]) => ({ ok: exitCode === 0, output: "", exitCode }));
  return { run, host: { run } as unknown as Host };
};

describe("checkGroup", () => {
  test("probes nothing once every machine serves", async () => {
    const { run, host } = hostAnswering(0);
    const results = await checkGroup([member(0, "running"), member(1, "running")], () => host);
    expect(results.map((result) => result.status)).toEqual(["pass"]);
    expect(results[0]!.message).toBe("attempt 1: rank 0 on spark-0 running, rank 1 on spark-1 running");
    expect(run).not.toHaveBeenCalled();
  });

  test("blames a host firewall when a waiting member gets no answer from rank 0's rendezvous", async () => {
    const { run, host } = hostAnswering(124);
    const results = await checkGroup([member(0, "admitted"), member(1, "admitted")], () => host);
    expect(run.mock.calls[0]).toEqual([["timeout", "5", "bash", "-c", "</dev/tcp/192.168.100.254/29500"]]);
    expect(results.at(-1)).toMatchObject({ status: "warn", message: expect.stringContaining("gets no answer from rank 0 at 192.168.100.254:29500, likely a host firewall") });
  });

  test("says nothing about the rendezvous while rank 0 is not listening yet", async () => {
    const { host } = hostAnswering(1);
    expect((await checkGroup([member(0, "preparing"), member(1, "admitted")], () => host)).map((result) => result.status)).toEqual(["pass"]);
  });

  test("fails a member that failed the current attempt, but not one that failed an earlier one", async () => {
    const { host } = hostAnswering(1);
    const failing = await checkGroup([member(0, "running"), member(1, "failed")], () => host);
    expect(failing.at(-1)).toEqual({ label: "qwen3.8-27b across 2 machines", status: "fail", message: "rank 1 on spark-1 failed in attempt 1" });
    const restarted = await checkGroup([member(0, "preparing", 2), { ...member(1, "failed"), group: { ...member(1, null).group, generation: 2 } }], () => host);
    expect(restarted.map((result) => result.status)).toEqual(["pass"]);
    expect(restarted[0]!.message).toContain("rank 1 on spark-1 not started");
  });

  test("warns about ranks on machines outside the stack", async () => {
    const { host } = hostAnswering(0);
    const results = await checkGroup([member(1, "running")], () => host);
    expect(results).toContainEqual({ label: "qwen3.8-27b across 2 machines", status: "warn", message: "rank 0 runs on a machine outside this stack and is not checked" });
  });
});
