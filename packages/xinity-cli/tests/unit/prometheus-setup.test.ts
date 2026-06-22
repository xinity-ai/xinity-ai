import { describe, expect, test } from "bun:test";
import { buildPrometheusConfig, buildComposeFile } from "../../src/lib/prometheus-setup.ts";

describe("buildPrometheusConfig", () => {
  const base = {
    scrapeInterval: "30s",
    gatewayTarget: "localhost:4121",
    dashboardTarget: "localhost:5121",
    daemonSdUrl: "http://localhost:5121/metrics/sd/daemons",
  };

  test("emits the three xinity scrape jobs", () => {
    const yml = buildPrometheusConfig(base);
    expect(yml).toContain("job_name: xinity-gateway");
    expect(yml).toContain("job_name: xinity-dashboard");
    expect(yml).toContain("job_name: xinity-daemon");
    expect(yml).toContain("scrape_interval: 30s");
  });

  test("scrapes gateway and dashboard statically", () => {
    const yml = buildPrometheusConfig(base);
    expect(yml).toContain("- localhost:4121");
    expect(yml).toContain("- localhost:5121");
  });

  test("discovers daemons via http_sd, not a static list", () => {
    const yml = buildPrometheusConfig(base);
    expect(yml).toContain("http_sd_configs:");
    expect(yml).toContain("- url: http://localhost:5121/metrics/sd/daemons");
    expect(yml).not.toContain("static_configs:\n      - targets:\n          - 10."); // no daemon static list
  });

  test("re-discovers the daemon set on a coarse interval, separate from scrape_interval", () => {
    const yml = buildPrometheusConfig(base);
    expect(yml).toContain("refresh_interval: 3m");
    expect(yml).toContain("scrape_interval: 30s"); // metric resolution stays fine-grained
  });

  test("omits basic_auth (as commented placeholders) when no creds are given", () => {
    const yml = buildPrometheusConfig(base);
    expect(yml).toContain("# basic_auth:");
    expect(yml).not.toMatch(/^\s+basic_auth:/m); // no active basic_auth block
  });

  test("omits scheme for http targets (Prometheus default) and emits scheme: https for https ones", () => {
    expect(buildPrometheusConfig(base)).not.toContain("scheme: https");
    const httpsYml = buildPrometheusConfig({
      ...base,
      gatewayScheme: "https",
      dashboardScheme: "https",
    });
    expect(httpsYml).toContain("scheme: https");
  });

  test("emits active basic_auth blocks for SD and daemon scrape when creds are given", () => {
    const yml = buildPrometheusConfig({
      ...base,
      sdAuth: { username: "sd", password: "sdpass" },
      daemonAuth: { username: "scrape", password: "scrapepass" },
    });
    expect(yml).toContain("username: sd");
    expect(yml).toContain("password: sdpass");
    expect(yml).toContain("username: scrape");
    expect(yml).toContain("password: scrapepass");
    expect(yml).toMatch(/^\s+basic_auth:/m);
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
