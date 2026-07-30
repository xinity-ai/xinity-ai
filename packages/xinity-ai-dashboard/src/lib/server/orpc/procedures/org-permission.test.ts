import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ORG_MIDDLEWARE = ".use(withOrganization)";

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/** withOrganization selects the organization. requirePermission authorizes the caller. */
function unguardedProcedureLines(source: string): number[] {
  const offenders: number[] = [];
  for (let at = source.indexOf(ORG_MIDDLEWARE); at !== -1; at = source.indexOf(ORG_MIDDLEWARE, at + 1)) {
    const handlerAt = source.indexOf(".handler(", at);
    const chain = handlerAt === -1 ? source.slice(at) : source.slice(at, handlerAt);
    if (!chain.includes("requirePermission")) {
      offenders.push(lineNumberAt(source, at));
    }
  }
  return offenders;
}

const procedureFiles = readdirSync(import.meta.dir).filter(name => name.endsWith(".procedure.ts"));

describe("unguardedProcedureLines", () => {
  const guarded = [
    "const listThings = rootOs",
    "  .use(withOrganization)",
    "  .use(requirePermission({ thing: [\"read\"] }))",
    "  .handler(async () => []);",
  ].join("\n");

  test("accepts a procedure that also requires a permission", () => {
    expect(unguardedProcedureLines(guarded)).toEqual([]);
  });

  test("reports a procedure that omits the permission check", () => {
    const unguarded = guarded.split("\n").filter(line => !line.includes("requirePermission")).join("\n");

    expect(unguardedProcedureLines(unguarded)).toEqual([2]);
  });

  test("does not let a later procedure's permission check cover an earlier one", () => {
    expect(unguardedProcedureLines(guarded.replace("  .use(requirePermission", "  .handler(x);\n  .use(requirePermission")))
      .toEqual([2]);
  });
});

describe("organization-scoped procedures", () => {
  test("the scan actually finds procedures to check", () => {
    const total = procedureFiles.reduce(
      (count, name) => count + readFileSync(join(import.meta.dir, name), "utf8").split(ORG_MIDDLEWARE).length - 1,
      0,
    );

    expect(total).toBeGreaterThan(0);
  });

  // Tests dynamically created for all procedure files
  for (const name of procedureFiles) {
    test(`${name} pairs every withOrganization with requirePermission`, () => {
      const source = readFileSync(join(import.meta.dir, name), "utf8");

      expect(unguardedProcedureLines(source)).toEqual([]);
    });
  }
});
