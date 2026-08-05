import { describe, expect, test } from "bun:test";
import { buildPrometheusConfig, buildComposeFile } from "../../src/lib/prometheus-setup.ts";

// Both files are built by string concatenation, so the only failure mode worth
// testing is a document Prometheus or Compose would reject or silently misread.
// Parsing the output catches that; substring matching cannot.

type ScrapeJob = {
  job_name: string;
  metrics_path: string;
  scheme?: string;
  basic_auth?: Record<string, string>;
  static_configs?: { targets: string[] }[];
  http_sd_configs?: { url: string; refresh_interval: string; basic_auth?: Record<string, string> }[];
};

function parseConfig(yml: string) {
  return Bun.YAML.parse(yml) as { global: Record<string, string>; scrape_configs: ScrapeJob[] };
}

const base = {
  scrapeInterval: "30s",
  gatewayTarget: "localhost:4121",
  dashboardTarget: "localhost:5121",
  tetherTarget: "localhost:4020",
  daemonSdUrl: "http://localhost:5121/metrics/sd/daemons",
};

describe("buildPrometheusConfig", () => {
  test("every xinity component ends up as a job aimed at its own target", () => {
    const cfg = parseConfig(buildPrometheusConfig(base));

    expect(cfg.global.scrape_interval).toBe("30s");
    expect(
      cfg.scrape_configs.map((j) => [
        j.job_name,
        j.static_configs?.[0]!.targets[0] ?? j.http_sd_configs![0]!.url,
      ]),
    ).toEqual([
      ["xinity-gateway", "localhost:4121"],
      ["xinity-dashboard", "localhost:5121"],
      ["xinity-tether", "localhost:4020"],
      ["xinity-daemon", "http://localhost:5121/metrics/sd/daemons"],
    ]);
    expect(cfg.scrape_configs.every((j) => j.metrics_path === "/metrics")).toBe(true);
    expect(cfg.scrape_configs.some((j) => j.basic_auth)).toBe(false);
  });

  test("credentials attach to the SD request and the daemon scrape independently", () => {
    const cfg = parseConfig(buildPrometheusConfig({
      ...base,
      sdAuth: { username: "sd", password: "sdpass" },
      daemonAuth: { username: "scrape", password: "scrapepass" },
    }));
    const daemon = cfg.scrape_configs.find((j) => j.job_name === "xinity-daemon")!;

    expect(daemon.http_sd_configs![0]!.basic_auth).toEqual({ username: "sd", password: "sdpass" });
    expect(daemon.basic_auth).toEqual({ username: "scrape", password: "scrapepass" });
  });

  test("https targets carry an explicit scheme, http ones rely on the Prometheus default", () => {
    const cfg = parseConfig(buildPrometheusConfig({ ...base, gatewayScheme: "https" }));
    const byName = (name: string) => cfg.scrape_configs.find((j) => j.job_name === name)!;

    expect(byName("xinity-gateway").scheme).toBe("https");
    expect(byName("xinity-dashboard").scheme).toBeUndefined();
  });
});

describe("buildComposeFile", () => {
  const configPath = "/etc/xinity-ai/infra/prometheus/prometheus.yml";

  test("host-networked prometheus with the config mounted read-only and a persistent tsdb", () => {
    const compose = Bun.YAML.parse(buildComposeFile(9091, configPath)) as {
      services: Record<string, { image: string; network_mode: string; command: string[]; volumes: string[] }>;
      volumes: Record<string, unknown>;
    };
    const prometheus = compose.services.prometheus!;

    expect(prometheus.image).toBe("prom/prometheus:v3.1.0");
    expect(prometheus.network_mode).toBe("host");
    expect(prometheus.command).toContain("--web.listen-address=127.0.0.1:9091");
    expect(prometheus.volumes).toContain(`${configPath}:/etc/prometheus/prometheus.yml:ro`);
    expect(Object.keys(compose.volumes)).toContain("xinity-prometheus-data");
  });
});
