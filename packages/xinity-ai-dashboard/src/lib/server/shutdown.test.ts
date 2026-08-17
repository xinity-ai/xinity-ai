import { describe, test, expect, beforeEach, mock } from "bun:test";

mock.module("$lib/server/logging", () => ({
  rootLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

const { onShutdown, runShutdownTasks, resetShutdownTasks } = await import("./shutdown");

beforeEach(() => {
  resetShutdownTasks();
});

describe("runShutdownTasks", () => {
  test("reports success with nothing registered", async () => {
    expect(await runShutdownTasks()).toBe(true);
  });

  test("runs every registered task", async () => {
    const ran: string[] = [];
    onShutdown("first", () => { ran.push("first"); });
    onShutdown("second", async () => { ran.push("second"); });

    expect(await runShutdownTasks()).toBe(true);
    expect(ran.sort()).toEqual(["first", "second"]);
  });

  test("runs tasks concurrently rather than one after another", async () => {
    const order: string[] = [];
    onShutdown("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("slow");
    });
    onShutdown("fast", async () => {
      order.push("fast");
    });

    await runShutdownTasks();
    expect(order).toEqual(["fast", "slow"]);
  });

  test("a throwing task does not stop the others", async () => {
    const ran: string[] = [];
    onShutdown("throws", () => { throw new Error("boom"); });
    onShutdown("rejects", async () => { throw new Error("boom async"); });
    onShutdown("survivor", () => { ran.push("survivor"); });

    expect(await runShutdownTasks()).toBe(true);
    expect(ran).toEqual(["survivor"]);
  });

  test("drops registrations on reset", async () => {
    const ran: string[] = [];
    onShutdown("gone", () => { ran.push("gone"); });
    resetShutdownTasks();

    await runShutdownTasks();
    expect(ran).toEqual([]);
  });
});
