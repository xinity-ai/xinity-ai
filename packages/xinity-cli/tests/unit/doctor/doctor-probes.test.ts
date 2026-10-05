import { describe, expect, test } from "bun:test";
import { checkDaemonHealth } from "../../../src/lib/doctor/doctor-probes.ts";
import { FakeHost } from "../../helpers/fake-host.ts";

const URL = "http://localhost:4044/healthCheck";
const SINCE = "2026-10-05T10:00:00.000Z";

function daemonAnswering(body: unknown, statusCode = 200): FakeHost {
  return new FakeHost({ run: () => ({ ok: true, output: `${JSON.stringify(body)}\n${statusCode}` }) });
}

describe("checkDaemonHealth", () => {
  test("passes a daemon connected to its tether", async () => {
    const checks = await checkDaemonHealth(daemonAnswering({ ready: true, tether: { state: "connected", since: SINCE } }), URL);

    expect(checks.map((c) => [c.label, c.status])).toEqual([
      ["Health endpoint", "pass"],
      ["Tether connection", "pass"],
    ]);
  });

  test("fails a daemon the tether refuses and names the category", async () => {
    const checks = await checkDaemonHealth(
      daemonAnswering({ ready: true, tether: { state: "refused", reason: "identity_mismatch", since: SINCE } }),
      URL,
    );

    expect(checks[1]).toMatchObject({ status: "fail", message: `Refused (identity_mismatch) since ${SINCE}` });
    expect(checks[1]!.detail).toContain("daemon logs");
  });

  test("checks only the status code of a daemon that predates the tether field", async () => {
    const checks = await checkDaemonHealth(daemonAnswering({ ready: true }), URL);

    expect(checks).toEqual([{ label: "Health endpoint", status: "pass", message: "Reachable (200)" }]);
  });

  test("reports no tether state for a failing health endpoint", async () => {
    const checks = await checkDaemonHealth(daemonAnswering("Internal Server Error", 500), URL);

    expect(checks).toEqual([{ label: "Health endpoint", status: "fail", message: "Returned 500" }]);
  });

  test("reports an unreachable daemon", async () => {
    const host = new FakeHost({ run: () => ({ ok: false, output: "\n000" }) });

    expect((await checkDaemonHealth(host, URL))[0]).toMatchObject({ status: "fail", message: "Unreachable" });
  });
});
