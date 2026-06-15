import { describe, expect, test } from "bun:test";
import { buildPrometheusConfig, buildComposeFile } from "../../src/lib/prometheus-setup.ts";

describe("buildPrometheusConfig", () => {
  const base = {
    scrapeInterval: "30s",
    gatewayTarget: "localhost:4121",
    dashboardTarget: "localhost:5121",
    daemonTargets: [] as string[],
  };

  test("emits the three xinity scrape jobs", () => {
    const yml = buildPrometheusConfig(base);
    expect(yml).toContain("job_name: xinity-gateway");
    expect(yml).toContain("job_name: xinity-dashboard");
    expect(yml).toContain("job_name: xinity-daemon");
    expect(yml).toContain("scrape_interval: 30s");
  });

  test("includes the gateway and dashboard targets", () => {
    const yml = buildPrometheusConfig(base);
    expect(yml).toContain("- localhost:4121");
    expect(yml).toContain("- localhost:5121");
  });

  test("emits an empty daemon target list with a pointer when none are given", () => {
    const yml = buildPrometheusConfig(base);
    expect(yml).toContain("[]");
    expect(yml).toContain("Instance Settings > Monitoring");
  });

  test("lists each daemon target when provided", () => {
    const yml = buildPrometheusConfig({ ...base, daemonTargets: ["10.0.0.5:4010", "10.0.0.6:4010"] });
    expect(yml).toContain("- 10.0.0.5:4010");
    expect(yml).toContain("- 10.0.0.6:4010");
    expect(yml).not.toContain("[]");
  });
});

describe("buildComposeFile", () => {
  const configPath = "/etc/xinity-ai/infra/prometheus/prometheus.yml";

  test("pins the prometheus image and uses host networking", () => {
    const compose = buildComposeFile(9090, configPath);
    expect(compose).toContain("image: prom/prometheus:v3.1.0");
    expect(compose).toContain("network_mode: host");
    expect(compose).toContain("container_name: xinity-ai-prometheus");
  });

  test("binds the web listener to the configured port on localhost", () => {
    expect(buildComposeFile(9091, configPath)).toContain("--web.listen-address=127.0.0.1:9091");
  });

  test("mounts the given config path read-only and persists tsdb in a named volume", () => {
    const compose = buildComposeFile(9090, configPath);
    expect(compose).toContain(`${configPath}:/etc/prometheus/prometheus.yml:ro`);
    expect(compose).toContain("xinity-prometheus-data:/prometheus");
  });
});
