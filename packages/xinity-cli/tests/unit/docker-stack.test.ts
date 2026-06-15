import { describe, expect, test } from "bun:test";
import { FakeHost } from "../helpers/fake-host.ts";
import { resolveComposeCmd, dockerDaemonReady, tcpPortInUse } from "../../src/lib/docker-stack.ts";

/** `command -v <name> || test -x ...` probe emitted by commandExistsOn. */
function present(...names: string[]) {
  return (cmd: string) =>
    names.some((n) => cmd.startsWith(`command -v ${n} || `)) ? { ok: true } : undefined;
}

describe("resolveComposeCmd", () => {
  test("prefers the docker compose v2 plugin", async () => {
    const host = new FakeHost({
      runShell: present("docker"),
      run: (args) => (args.join(" ") === "docker compose version" ? { ok: true } : undefined),
    });
    expect(await resolveComposeCmd(host)).toEqual({ docker: "docker", sub: ["compose"] });
  });

  test("falls back to legacy docker-compose when the v2 plugin is absent", async () => {
    const host = new FakeHost({
      runShell: present("docker", "docker-compose"),
      run: () => ({ ok: false }), // `docker compose version` fails
    });
    expect(await resolveComposeCmd(host)).toEqual({ docker: "docker-compose", sub: [] });
  });

  test("returns null when neither docker nor docker-compose is installed", async () => {
    const host = new FakeHost({ runShell: () => ({ ok: false }) });
    expect(await resolveComposeCmd(host)).toBeNull();
  });

  test("returns null when docker exists but has no compose and no legacy binary", async () => {
    const host = new FakeHost({
      runShell: present("docker"),
      run: () => ({ ok: false }),
    });
    expect(await resolveComposeCmd(host)).toBeNull();
  });
});

describe("dockerDaemonReady", () => {
  test("true when `docker info` succeeds", async () => {
    const host = new FakeHost({ run: (a) => (a.join(" ") === "docker info" ? { ok: true } : undefined) });
    expect(await dockerDaemonReady(host)).toBe(true);
  });

  test("false when `docker info` fails (daemon down / no socket access)", async () => {
    const host = new FakeHost({ run: () => ({ ok: false }) });
    expect(await dockerDaemonReady(host)).toBe(false);
  });
});

describe("tcpPortInUse", () => {
  test("true when ss reports a listener", async () => {
    const host = new FakeHost({
      run: (a) => (a[0] === "ss" ? { ok: true, output: "LISTEN 0 4096 127.0.0.1:5432" } : undefined),
    });
    expect(await tcpPortInUse(host, 5432)).toBe(true);
  });

  test("falls through to lsof when ss is empty", async () => {
    const host = new FakeHost({
      run: (a) => {
        if (a[0] === "ss") return { ok: true, output: "" };
        if (a[0] === "lsof") return { ok: true, output: "1234" };
        return undefined;
      },
    });
    expect(await tcpPortInUse(host, 5432)).toBe(true);
  });

  test("false when neither tool finds a listener (or neither is installed)", async () => {
    const host = new FakeHost({ run: () => ({ ok: false }) });
    expect(await tcpPortInUse(host, 5432)).toBe(false);
  });
});
