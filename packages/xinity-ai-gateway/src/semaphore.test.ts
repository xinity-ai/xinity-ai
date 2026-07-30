import { describe, test, expect } from "bun:test";
import { createSemaphore } from "./semaphore";

describe("createSemaphore", () => {
  test("grants up to the limit immediately", async () => {
    const sem = createSemaphore(2);

    expect(await sem.acquire(50)).toBe(true);
    expect(await sem.acquire(50)).toBe(true);
    expect(sem.active()).toBe(2);
  });

  test("queues beyond the limit and hands the slot on release", async () => {
    const sem = createSemaphore(1);
    await sem.acquire(50);

    const queued = sem.acquire(1_000);
    expect(sem.waiting()).toBe(1);

    sem.release();
    expect(await queued).toBe(true);
    expect(sem.active()).toBe(1);
  });

  test("resolves false when the wait times out", async () => {
    const sem = createSemaphore(1);
    await sem.acquire(50);

    expect(await sem.acquire(10)).toBe(false);
    expect(sem.active()).toBe(1);
  });

  test("does not leak the slot to a waiter that already timed out", async () => {
    const sem = createSemaphore(1);
    await sem.acquire(50);

    expect(await sem.acquire(10)).toBe(false);
    sem.release();

    expect(sem.active()).toBe(0);
    expect(await sem.acquire(10)).toBe(true);
  });

  test("serves queued waiters in order", async () => {
    const sem = createSemaphore(1);
    await sem.acquire(50);
    const order: number[] = [];

    const first = sem.acquire(1_000).then(() => order.push(1));
    const second = sem.acquire(1_000).then(() => order.push(2));

    sem.release();
    await first;
    sem.release();
    await second;

    expect(order).toEqual([1, 2]);
  });
});
