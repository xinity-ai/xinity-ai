import { describe, expect, test } from "bun:test";
import { generateUnit, getComponentConfig, unitName } from "../../src/lib/systemd.ts";
import type { UnitConfig } from "../../src/lib/systemd.ts";

describe("systemd", () => {
  describe("unitName", () => {
    test("generates correct service name for gateway", () => {
      expect(unitName("gateway")).toBe("xinity-ai-gateway.service");
    });

    test("generates correct service name for dashboard", () => {
      expect(unitName("dashboard")).toBe("xinity-ai-dashboard.service");
    });

    test("generates correct service name for daemon", () => {
      expect(unitName("daemon")).toBe("xinity-ai-daemon.service");
    });
  });

  describe("getComponentConfig", () => {
    test("returns gateway config with correct exec path", () => {
      const config = getComponentConfig("gateway");
      expect(config.component).toBe("gateway");
      expect(config.description).toBe("Xinity AI Gateway");
      expect(config.execStart).toBe("/opt/xinity/bin/xinity-ai-gateway");
      expect(config.afterUnits).toContain("network-online.target");
    });

    test("returns dashboard config with binary runner", () => {
      const config = getComponentConfig("dashboard");
      expect(config.component).toBe("dashboard");
      expect(config.execStart).toBe("/opt/xinity/bin/xinity-ai-dashboard");
    });

    test("returns daemon config", () => {
      const config = getComponentConfig("daemon");
      expect(config.component).toBe("daemon");
      expect(config.execStart).toBe("/opt/xinity/bin/xinity-ai-daemon");
    });

    test("throws for unknown component", () => {
      expect(() => getComponentConfig("unknown")).toThrow("Unknown component: unknown");
    });
  });

  describe("generateUnit", () => {
    test("generates valid unit file with all sections", () => {
      const config: UnitConfig = {
        component: "gateway",
        description: "Test Service",
        execStart: "/usr/bin/test",
        secretKeys: [],
      };

      const unit = generateUnit(config);

      expect(unit).toContain("[Unit]");
      expect(unit).toContain("[Service]");
      expect(unit).toContain("[Install]");
    });

    test("includes description in Unit section", () => {
      const config: UnitConfig = {
        component: "gateway",
        description: "Xinity AI Gateway",
        execStart: "/opt/xinity/bin/xinity-ai-gateway",
        secretKeys: [],
      };

      const unit = generateUnit(config);
      expect(unit).toContain("Description=Xinity AI Gateway");
    });

    test("sets correct After and Wants targets", () => {
      const config: UnitConfig = {
        component: "gateway",
        description: "Test",
        execStart: "/test",
        secretKeys: [],
        afterUnits: ["network-online.target"],
      };

      const unit = generateUnit(config);
      expect(unit).toContain("After=network-online.target");
      expect(unit).toContain("Wants=network-online.target");
    });

    test("defaults to network-online.target when no afterUnits specified", () => {
      const config: UnitConfig = {
        component: "gateway",
        description: "Test",
        execStart: "/test",
        secretKeys: [],
      };

      const unit = generateUnit(config);
      expect(unit).toContain("After=network-online.target");
    });

    test("includes DynamicUser and StateDirectory", () => {
      const config: UnitConfig = {
        component: "gateway",
        description: "Test",
        execStart: "/test",
        secretKeys: [],
      };

      const unit = generateUnit(config);
      expect(unit).toContain("DynamicUser=yes");
      expect(unit).toContain("StateDirectory=xinity-ai-gateway");
    });

    test("includes EnvironmentFile for component", () => {
      const config: UnitConfig = {
        component: "dashboard",
        description: "Test",
        execStart: "/test",
        secretKeys: [],
      };

      const unit = generateUnit(config);
      expect(unit).toContain("EnvironmentFile=/etc/xinity-ai/dashboard.env");
    });

    test("generates LoadCredential entries for secrets", () => {
      const config: UnitConfig = {
        component: "gateway",
        description: "Test",
        execStart: "/test",
        secretKeys: ["DB_PASSWORD", "API_SECRET"],
      };

      const unit = generateUnit(config);
      expect(unit).toContain("LoadCredential=DB_PASSWORD:/etc/xinity-ai/secrets/DB_PASSWORD");
      expect(unit).toContain("LoadCredential=API_SECRET:/etc/xinity-ai/secrets/API_SECRET");
    });

    test("generates _FILE environment wiring for secrets", () => {
      const config: UnitConfig = {
        component: "gateway",
        description: "Test",
        execStart: "/test",
        secretKeys: ["DB_PASSWORD"],
      };

      const unit = generateUnit(config);
      expect(unit).toContain("Environment=DB_PASSWORD_FILE=%d/DB_PASSWORD");
    });

    test("omits secret entries when secretKeys is empty", () => {
      const config: UnitConfig = {
        component: "gateway",
        description: "Test",
        execStart: "/test",
        secretKeys: [],
      };

      const unit = generateUnit(config);
      expect(unit).not.toContain("LoadCredential");
      expect(unit).not.toContain("_FILE=%d/");
    });

    test("includes ExecStart", () => {
      const config: UnitConfig = {
        component: "gateway",
        description: "Test",
        execStart: "/opt/xinity/bin/xinity-ai-gateway",
        secretKeys: [],
      };

      const unit = generateUnit(config);
      expect(unit).toContain("ExecStart=/opt/xinity/bin/xinity-ai-gateway");
    });

    test("includes restart policy", () => {
      const config: UnitConfig = {
        component: "gateway",
        description: "Test",
        execStart: "/test",
        secretKeys: [],
      };

      const unit = generateUnit(config);
      expect(unit).toContain("Restart=on-failure");
      expect(unit).toContain("RestartSec=5");
    });

    test("includes security hardening options", () => {
      const config: UnitConfig = {
        component: "gateway",
        description: "Test",
        execStart: "/test",
        secretKeys: [],
      };

      const unit = generateUnit(config);
      expect(unit).toContain("NoNewPrivileges=true");
      expect(unit).toContain("ProtectSystem=strict");
      expect(unit).toContain("ProtectHome=yes");
      expect(unit).toContain("PrivateTmp=true");
    });

    test("includes Install section with multi-user target", () => {
      const config: UnitConfig = {
        component: "gateway",
        description: "Test",
        execStart: "/test",
        secretKeys: [],
      };

      const unit = generateUnit(config);
      expect(unit).toContain("WantedBy=multi-user.target");
    });

    test("ends with newline", () => {
      const config: UnitConfig = {
        component: "gateway",
        description: "Test",
        execStart: "/test",
        secretKeys: [],
      };

      const unit = generateUnit(config);
      expect(unit.endsWith("\n")).toBe(true);
    });

    test("produces a complete unit for a real component config", () => {
      const baseConfig = getComponentConfig("gateway");
      const config: UnitConfig = {
        ...baseConfig,
        secretKeys: ["DB_CONNECTION_URL"],
      };

      const unit = generateUnit(config);

      // Verify the unit is well-formed by checking section order
      const unitIdx = unit.indexOf("[Unit]");
      const serviceIdx = unit.indexOf("[Service]");
      const installIdx = unit.indexOf("[Install]");

      expect(unitIdx).toBeGreaterThanOrEqual(0);
      expect(serviceIdx).toBeGreaterThan(unitIdx);
      expect(installIdx).toBeGreaterThan(serviceIdx);
    });
  });
});
