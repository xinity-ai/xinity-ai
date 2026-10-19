import { couplingDocsUrl, type GroupMemberHealth } from "common-env";
import type { Host } from "../core/host.ts";
import type { CheckResult } from "./doctor-probes.ts";

export type HostedMember = GroupMemberHealth & { hostName: string };

const PROBE_TIMED_OUT = 124;

export async function checkGroup(members: HostedMember[], hostOf: (hostName: string) => Host): Promise<CheckResult[]> {
  const generation = Math.max(...members.map((member) => member.group.generation));
  const current = members.filter((member) => member.group.generation === generation).toSorted((a, b) => a.group.rank - b.group.rank);
  const { specifier, group: { size } } = current[0]!;
  const label = `${specifier} across ${size} machines`;
  const stageOf = (member: HostedMember) => (member.stageGeneration === generation ? member.stage : null);

  const results: CheckResult[] = [{
    label,
    status: "pass",
    message: `attempt ${generation}: ${current.map((member) => `rank ${member.group.rank} on ${member.hostName} ${stageOf(member) ?? "not started"}`).join(", ")}`,
  }];
  const missing = Array.from({ length: size }, (_, rank) => rank).filter((rank) => !current.some((member) => member.group.rank === rank));
  if (missing.length > 0) {
    results.push({ label, status: "warn", message: `rank ${missing.join(", ")} runs on a machine outside this stack and is not checked` });
  }
  const failed = current.filter((member) => stageOf(member) === "failed");
  for (const member of failed) {
    results.push({ label, status: "fail", message: `rank ${member.group.rank} on ${member.hostName} failed in attempt ${generation}` });
  }
  if (failed.length > 0) {
    return results;
  }

  // Once every member runs, the rendezvous is behind them. Before that, a member that cannot reach
  // rank 0 waits for good, which a host firewall on the coupling causes.
  for (const member of current.filter((candidate) => candidate.group.rank > 0 && stageOf(candidate) !== "running")) {
    const target = `${member.group.masterAddress}:${member.group.rendezvousPort}`;
    const probe = await hostOf(member.hostName).run(["timeout", "5", "bash", "-c", `</dev/tcp/${member.group.masterAddress}/${member.group.rendezvousPort}`]);
    if (probe.exitCode === PROBE_TIMED_OUT) {
      results.push({
        label,
        status: "warn",
        message: `rank ${member.group.rank} on ${member.hostName} gets no answer from rank 0 at ${target}, likely a host firewall on the coupling (${couplingDocsUrl("test-connection-blocked")})`,
      });
    } else if (probe.ok) {
      results.push({ label, status: "pass", message: `rank ${member.group.rank} on ${member.hostName} reaches rank 0 at ${target}` });
    }
  }
  return results;
}
