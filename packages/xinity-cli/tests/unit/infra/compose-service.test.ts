import { describe, expect, test } from "bun:test";
import { FakeHost } from "../../helpers/fake-host.ts";
import {
  type ComposeStack, stackPaths, inspectStack, parsePublishedPort,
  buildWriteFileCommand,
} from "../../../src/lib/infra/compose-service.ts";

const PUBLISHED: ComposeStack = {
  name: "postgres",
  displayName: "PostgreSQL",
  containerName: "xinity-ai-postgres",
  image: "postgres:17.4-alpine",
  containerPort: 5432,
  defaultPort: 5432,
  volumeName: "xinity-postgres-data",
};

const HOST_NETWORKED: ComposeStack = {
  name: "prometheus",
  displayName: "Prometheus",
  containerName: "xinity-ai-prometheus",
  image: "prom/prometheus:v3.1.0",
  defaultPort: 9090,
};

describe("parsePublishedPort", () => {
  test("recovers the published port for the stack's own container port", () => {
    expect(parsePublishedPort('- "127.0.0.1:5544:5432"', PUBLISHED)).toBe(5544);
  });

  test("ignores a mapping that belongs to a different container port", () => {
    expect(parsePublishedPort('- "127.0.0.1:5544:6379"', PUBLISHED)).toBe(5432);
  });

  test("falls back to the default when no published port is present", () => {
    expect(parsePublishedPort("services: {}", PUBLISHED)).toBe(5432);
  });

  test("a host-networked stack publishes nothing, so it always reports the default", () => {
    expect(parsePublishedPort('- "127.0.0.1:5544:9090"', HOST_NETWORKED)).toBe(9090);
  });
});

describe("buildWriteFileCommand", () => {
  test("writes through a heredoc so the content needs no escaping", () => {
    const cmd = buildWriteFileCommand(PUBLISHED, "/tmp/x.yml", "a: 1\nb: '2'");
    expect(cmd).toStartWith("cat > /tmp/x.yml << 'XINITY_POSTGRES_EOF_");
    expect(cmd).toContain("a: 1\nb: '2'");
    expect(cmd).not.toContain("chmod");
  });

  test("appends a chmod when a mode is given", () => {
    expect(buildWriteFileCommand(PUBLISHED, "/tmp/x.env", "K=v", "600"))
      .toEndWith("\nchmod 600 /tmp/x.env");
  });
});

describe("inspectStack", () => {
  test("reports a fully provisioned stack (volume + compose file)", async () => {
    const host = new FakeHost({
      run: (a) => (a[0] === "docker" && a[1] === "volume" ? { ok: true } : undefined),
      files: { [stackPaths(PUBLISHED).composePath]: "services: {}\n" },
    });
    const existing = await inspectStack(host, PUBLISHED);
    expect(existing.volumeExists).toBe(true);
    expect(existing.composeFile).toContain("services");
  });

  test("reports a clean host (no volume, no compose file)", async () => {
    const host = new FakeHost({ run: () => ({ ok: false }) });
    const existing = await inspectStack(host, PUBLISHED);
    expect(existing.volumeExists).toBe(false);
    expect(existing.composeFile).toBeNull();
  });

  test("a stack with no named volume never probes for one", async () => {
    const host = new FakeHost({ run: () => ({ ok: true, output: "" }) });
    const existing = await inspectStack(host, HOST_NETWORKED);
    expect(existing.volumeExists).toBe(false);
    expect(host.calls.some((c) => c.includes("volume inspect"))).toBe(false);
  });
});
