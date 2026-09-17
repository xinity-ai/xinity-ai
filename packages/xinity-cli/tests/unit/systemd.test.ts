import { describe, expect, test } from "bun:test";
import { generateUnit } from "../../src/lib/systemd.ts";
import type { UnitConfig } from "../../src/lib/systemd.ts";

describe("systemd", () => {
  describe("generateUnit", () => {
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

    test("root services are unsandboxed unless they opt in", () => {
      const base: UnitConfig = {
        component: "daemon",
        description: "Test",
        execStart: "/test",
        secretKeys: [],
        runAsRoot: true,
      };

      expect(generateUnit(base)).not.toContain("ProtectSystem=strict");

      const hardened = generateUnit({ ...base, hardened: true, readWritePaths: ["/var/lib/data"] });
      expect(hardened).toContain("ProtectSystem=strict");
      expect(hardened).toContain("ReadWritePaths=/var/lib/data");
    });

    test("omits EnvironmentFile when the service has no env file", () => {
      const config: UnitConfig = {
        component: "seaweedfs",
        description: "Test",
        execStart: "/test",
        secretKeys: [],
        environmentFile: null,
      };

      expect(generateUnit(config)).not.toContain("EnvironmentFile");
    });
  });
});
