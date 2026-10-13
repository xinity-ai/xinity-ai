import { describe, test, expect, spyOn, afterEach, afterAll } from "bun:test";
import { RedisClient } from "bun";
import { memoryCache, redisCache } from "./cache";

let now = 1_000_000;
const clock = spyOn(Date, "now").mockImplementation(() => now);

afterEach(() => {
  now = 1_000_000;
});

afterAll(() => {
  clock.mockRestore();
});

describe("memoryCache", () => {
  test("an entry is gone once its ttl has passed", async () => {
    const cache = memoryCache();
    await cache.set("k", "v", 10);
    now += 9_999;
    expect(await cache.get("k")).toBe("v");
    now += 1;
    expect(await cache.get("k")).toBeNull();
  });

  test("incr counts from zero and every increment extends the ttl", async () => {
    const cache = memoryCache();
    expect(await cache.incr("n", 10)).toBe(1);
    now += 9_000;
    expect(await cache.incr("n", 10)).toBe(2);
    now += 9_000;
    expect(await cache.mget(["n"])).toEqual(["2"]);
  });

  test("tryIncr refuses at the limit and admits again after a decr", async () => {
    const cache = memoryCache();
    expect(await cache.tryIncr("n", 2, 10)).toBe(true);
    expect(await cache.tryIncr("n", 2, 10)).toBe(true);
    expect(await cache.tryIncr("n", 2, 10)).toBe(false);
    await cache.decr("n");
    expect(await cache.tryIncr("n", 2, 10)).toBe(true);
  });

  test("decr does not bring back an expired counter", async () => {
    const cache = memoryCache();
    await cache.incr("n", 1);
    now += 1_000;
    await cache.decr("n");
    expect(await cache.get("n")).toBeNull();
  });

  test("delPrefix removes only the matching keys", async () => {
    const cache = memoryCache();
    await cache.set("dep:a", "1", 60);
    await cache.set("dep:b", "1", 60);
    await cache.set("app:a", "1", 60);
    await cache.delPrefix("dep:");
    expect(await cache.mget(["dep:a", "dep:b", "app:a"])).toEqual([null, null, "1"]);
  });
});

describe("redisCache", () => {
  const send = spyOn(RedisClient.prototype, "send");

  afterEach(() => {
    send.mockReset();
  });

  afterAll(() => {
    send.mockRestore();
  });

  test("delPrefix follows the scan cursor to the end and deletes every page", async () => {
    const deleted: string[][] = [];
    send.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "SCAN") {
        return args[0] === "0" ? ["7", ["dep:a"]] : ["0", ["dep:b"]];
      }
      deleted.push(args);
      return 1;
    });

    await redisCache("redis://localhost:6379").delPrefix("dep:");

    expect(deleted).toEqual([["dep:a"], ["dep:b"]]);
  });

  test("delPrefix skips the delete when a page is empty", async () => {
    send.mockImplementation(async (cmd: string) => (cmd === "SCAN" ? ["0", []] : 1));

    await redisCache("redis://localhost:6379").delPrefix("dep:");

    expect(send.mock.calls.map(([cmd]) => cmd)).toEqual(["SCAN"]);
  });
});
