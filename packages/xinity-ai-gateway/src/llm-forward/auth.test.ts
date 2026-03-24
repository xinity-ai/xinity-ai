import { describe, test, expect, mock, jest, beforeEach, afterEach, spyOn } from "bun:test";
import { redis } from "bun";

// --- Mocks (hoisted by bun:test) ---

mock.module("../env", () => ({
  env: {
    HOST: "localhost",
    PORT: 4010,
    DB_CONNECTION_URL: "postgresql://localhost/test",
    REDIS_URL: "redis://localhost:6379",
    WEB_SEARCH_ENGINE_URL: undefined,
    RESPONSE_CACHE_TTL_SECONDS: 3600,
    INFOSERVER_URL: "http://localhost:3000",
    INFOSERVER_CACHE_TTL_MS: 30000,
    LOAD_BALANCE_STRATEGY: "random",
    BACKEND_TIMEOUT_MS: 300000,
    LOG_LEVEL: "info",
    LOG_DIR: undefined,
    METRICS_AUTH: undefined,
  },
}));

const mockQueryResult: any[] = [];
const mockGetDB = jest.fn(() => ({
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(mockQueryResult),
      }),
    }),
  }),
}));
mock.module("../db", () => ({ getDB: mockGetDB }));

// --- Import under test ---

import type { AuthResult } from "./auth";
const { checkAuth } = await import("./auth");

// --- Test data ---

const FIXED_PREFIX = "test_prefix______________"; // exactly 25 chars

const fakeApiKey = {
  id: "key-123",
  organizationId: "org-456",
  applicationId: "app-789",
  collectData: true,
  enabled: true,
  deletedAt: null,
  hash: "$argon2id$v=19$m=65536,t=2,p=1$fakesalt$fakehash",
  specifier: FIXED_PREFIX,
  name: "Test Key",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeBearerHeader(prefix?: string): string {
  return `Bearer ${prefix ?? FIXED_PREFIX}SECRETSUFFIX`;
}

// --- Redis spies ---

let mockRedisGetex: ReturnType<typeof spyOn>;
let mockRedisSet: ReturnType<typeof spyOn>;

// --- Helpers ---

async function expectUnauthorized(result: Response | AuthResult, detail?: string) {
  expect(result).toBeInstanceOf(Response);
  const res = result as Response;
  expect(res.status).toBe(401);
  const body = await res.json() as { error: { type: string; message: string } };
  expect(body.error.type).toBe("authentication_error");
  if (detail) {
    expect(body.error.message).toBe(detail);
  }
}

// --- Tests ---

describe("checkAuth", () => {
  beforeEach(() => {
    mockGetDB.mockClear();
    mockQueryResult.length = 0;

    // Default: cache miss, set succeeds
    mockRedisGetex = spyOn(redis, "getex").mockResolvedValue(null);
    mockRedisSet = spyOn(redis, "set").mockResolvedValue("OK" as any);
  });

  afterEach(() => {
    mockRedisGetex.mockRestore();
    mockRedisSet.mockRestore();
  });

  test("returns 401 when auth header doesn't start with 'Bearer '", async () => {
    const result = await checkAuth("Basic abc123");
    await expectUnauthorized(result, "Missing API Key");
  });

  test("returns 401 when auth header is empty string", async () => {
    const result = await checkAuth("");
    await expectUnauthorized(result, "Missing API Key");
  });

  test("returns AuthResult from Redis cache when key is cached", async () => {
    const cached = {
      id: "cached-key",
      organizationId: "cached-org",
      applicationId: "cached-app",
      collectData: false,
    };
    mockRedisGetex.mockResolvedValue(JSON.stringify(cached));

    const result = await checkAuth(makeBearerHeader());

    expect(result).not.toBeInstanceOf(Response);
    const auth = result as AuthResult;
    expect(auth.keyId).toBe("cached-key");
    expect(auth.orgId).toBe("cached-org");
    expect(auth.applicationId).toBe("cached-app");
    expect(auth.collectData).toBe(false);
    // Should not hit DB
    expect(mockGetDB).not.toHaveBeenCalled();
  });

  test("returns collectData true by default from cache when field is missing", async () => {
    const cached = {
      id: "cached-key",
      organizationId: "cached-org",
      applicationId: null,
      // collectData intentionally omitted
    };
    mockRedisGetex.mockResolvedValue(JSON.stringify(cached));

    const result = await checkAuth(makeBearerHeader());

    expect(result).not.toBeInstanceOf(Response);
    const auth = result as AuthResult;
    expect(auth.collectData).toBe(true);
  });

  test("returns 401 when API key prefix not found in DB", async () => {
    // No cache, no DB result
    mockQueryResult.length = 0;

    const result = await checkAuth(makeBearerHeader());
    await expectUnauthorized(result, "API Key not found");
    expect(mockGetDB).toHaveBeenCalled();
  });

  test("returns 401 when API key is disabled", async () => {
    mockQueryResult.push({ ...fakeApiKey, enabled: false });

    const result = await checkAuth(makeBearerHeader());
    await expectUnauthorized(result, "API Key is disabled");
  });

  test("returns 401 when API key is deleted", async () => {
    mockQueryResult.push({ ...fakeApiKey, deletedAt: new Date() });

    const result = await checkAuth(makeBearerHeader());
    await expectUnauthorized(result, "API Key has been deleted");
  });

  test("returns 401 when password verification fails", async () => {
    mockQueryResult.push({ ...fakeApiKey });

    const originalVerify = Bun.password.verify;
    Bun.password.verify = jest.fn(() => Promise.resolve(false)) as any;

    try {
      const result = await checkAuth(makeBearerHeader());
      await expectUnauthorized(result);
    } finally {
      Bun.password.verify = originalVerify;
    }
  });

  test("returns 401 when password verification throws", async () => {
    mockQueryResult.push({ ...fakeApiKey });

    const originalVerify = Bun.password.verify;
    Bun.password.verify = jest.fn(() => Promise.reject(new Error("hash error"))) as any;

    try {
      const result = await checkAuth(makeBearerHeader());
      await expectUnauthorized(result);
    } finally {
      Bun.password.verify = originalVerify;
    }
  });

  test("returns AuthResult on successful verification and caches in Redis", async () => {
    mockQueryResult.push({ ...fakeApiKey });

    const originalVerify = Bun.password.verify;
    Bun.password.verify = jest.fn(() => Promise.resolve(true)) as any;

    try {
      const result = await checkAuth(makeBearerHeader());

      expect(result).not.toBeInstanceOf(Response);
      const auth = result as AuthResult;
      expect(auth.keyId).toBe("key-123");
      expect(auth.orgId).toBe("org-456");
      expect(auth.applicationId).toBe("app-789");
      expect(auth.collectData).toBe(true);

      // Verify it was cached in Redis
      expect(mockRedisSet).toHaveBeenCalled();
      const [cacheKey, cacheValue] = mockRedisSet.mock.calls[0];
      expect(cacheKey).toBe(`apikey:${FIXED_PREFIX}`);
      const cached = JSON.parse(cacheValue);
      expect(cached.id).toBe("key-123");
      expect(cached.organizationId).toBe("org-456");
    } finally {
      Bun.password.verify = originalVerify;
    }
  });

  test("returns AuthResult with null applicationId when not set", async () => {
    mockQueryResult.push({ ...fakeApiKey, applicationId: null });

    const originalVerify = Bun.password.verify;
    Bun.password.verify = jest.fn(() => Promise.resolve(true)) as any;

    try {
      const result = await checkAuth(makeBearerHeader());

      expect(result).not.toBeInstanceOf(Response);
      const auth = result as AuthResult;
      expect(auth.applicationId).toBeNull();
    } finally {
      Bun.password.verify = originalVerify;
    }
  });
});
