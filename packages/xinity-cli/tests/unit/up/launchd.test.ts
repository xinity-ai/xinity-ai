import { describe, expect, test } from "bun:test";
import { generatePlist } from "../../../src/lib/up/launchd.ts";
import { SERVICE_MANAGERS } from "../../../src/lib/up/service-manager.ts";

describe("generatePlist", () => {
  test("carries the configuration, escaped for XML, and points secrets at their files", () => {
    const plist = generatePlist("daemon", { TETHER_URL: "http://tether:4020/?a=1&b=<2>" }, ["TETHER_SECRET"]);
    expect(plist).toContain("<key>TETHER_URL</key>\n    <string>http://tether:4020/?a=1&amp;b=&lt;2&gt;</string>");
    expect(plist).toContain("<key>TETHER_SECRET_FILE</key>\n    <string>/etc/xinity-ai/secrets/TETHER_SECRET</string>");
    expect(plist).not.toContain("<key>TETHER_SECRET</key>");
  });
});

describe("launchd status", () => {
  const { parseStatus } = SERVICE_MANAGERS.darwin;

  test("is active only while the job runs", () => {
    const print = (state: string) => ({ ok: true, exitCode: 0, output: `system/ai.xinity.daemon = {\n\tactive count = 1\n\tstate = ${state}\n\tprogram = /opt/xinity/bin/xinity-ai-daemon\n}` });
    expect(parseStatus(print("running"))).toEqual({ active: true, state: "running" });
    expect(parseStatus(print("spawn scheduled"))).toEqual({ active: false, state: "spawn scheduled" });
  });

  test("reports a job launchd does not know as not loaded", () => {
    expect(parseStatus({ ok: false, exitCode: 113, output: "Could not find service" })).toEqual({ active: false, state: "not loaded" });
  });
});
