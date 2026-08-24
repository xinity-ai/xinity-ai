import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import { MultiTenantGraphStorage } from "./db/graphStorage";
import { RepositoryIndexer } from "./indexing/indexer";
import { generateJwtToken, verifyJwtToken, hasPermission, assertPermission } from "./auth/rbac";

const TEST_DB = "./test_xinity_code_graph.json";
const TEST_DIR = "./test_repo_fixture";

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });

  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TEST_DIR, "service.ts"),
    `
    import { Helper } from "./helper";

    export interface UserProfile {
      id: string;
      name: string;
    }

    export class UserService {
      public getUser(): UserProfile {
        return { id: "1", name: "Alice" };
      }
    }

    export function calculateTotal(a: number, b: number): number {
      return a + b;
    }
    `
  );
  fs.writeFileSync(
    path.join(TEST_DIR, "helper.ts"),
    `
    export class Helper {
      public static log(msg: string) {
        console.log(msg);
      }
    }
    `
  );
});

afterEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("xinity-code-intelligence", () => {
  test("JWT generation and verification", () => {
    const token = generateJwtToken({
      tenantId: "acme",
      userId: "dev-1",
      roles: ["developer"],
      accessibleRepos: ["repo-1"]
    });

    const decoded = verifyJwtToken(token);
    expect(decoded.tenantId).toBe("acme");
    expect(decoded.userId).toBe("dev-1");
    expect(decoded.roles).toEqual(["developer"]);
    expect(decoded.accessibleRepos).toEqual(["repo-1"]);
  });

  test("RBAC permission checks", () => {
    const context = {
      tenantId: "acme",
      userId: "dev-1",
      roles: ["developer" as const],
      accessibleRepos: ["repo-1"]
    };

    expect(hasPermission(context, "graph:read", "repo-1")).toBe(true);
    expect(hasPermission(context, "graph:read", "repo-forbidden")).toBe(false);
    expect(hasPermission(context, "graph:admin", "repo-1")).toBe(false);
    expect(() => assertPermission(context, "graph:admin", "repo-1")).toThrow();
  });

  test("AST Indexer builds graph with nodes, classes, functions, and cross-file imports", async () => {
    const storage = new MultiTenantGraphStorage(TEST_DB);
    const indexer = new RepositoryIndexer(storage);

    const result = await indexer.indexRepository({
      tenantId: "acme",
      repoId: "repo-1",
      rootDir: TEST_DIR
    });

    expect(result.totalFiles).toBe(2);
    expect(result.totalNodes).toBeGreaterThan(4);
    expect(result.totalEdges).toBeGreaterThan(2);

    const symbols = storage.querySymbols("acme", "UserService", "repo-1");
    expect(symbols.length).toBeGreaterThanOrEqual(1);
    const classNode = symbols.find(s => s.type === "class");
    expect(classNode).toBeDefined();
    expect(classNode!.name).toBe("UserService");

    const helperSymbols = storage.querySymbols("acme", "Helper", "repo-1");
    expect(helperSymbols.length).toBeGreaterThanOrEqual(1);
    const helperClass = helperSymbols.find(s => s.type === "class");
    expect(helperClass).toBeDefined();
    expect(helperClass!.name).toBe("Helper");

    const overview = storage.getTenantOverview("acme", "repo-1");
    expect(overview.symbolsByType["class"]).toBeGreaterThanOrEqual(2);
    expect(overview.symbolsByType["function"]).toBeGreaterThanOrEqual(2);

    storage.close();
  });
});
