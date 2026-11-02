/** The bounded hashing limiter (ADR-004 P-7; issue #258). */

import { afterEach, describe, expect, it, vi } from "vitest";

import { HashLimiter, type HashSlot } from "./hash-limiter";

afterEach(() => {
  vi.useRealTimers();
});

function isSlot(value: HashSlot | "overloaded"): value is HashSlot {
  return value !== "overloaded";
}

describe("hash limiter", () => {
  it("runs at most 2, queues at most 8, and refuses the 11th at once", async () => {
    const limiter = new HashLimiter();
    const running = await Promise.all([limiter.acquire(), limiter.acquire()]);
    const queued = Array.from({ length: 8 }, () => limiter.acquire());

    expect(running.every(isSlot)).toBe(true);
    expect(limiter.running).toBe(2);
    expect(limiter.queued).toBe(8);
    expect(await limiter.acquire()).toBe("overloaded");

    for (const slot of running.filter(isSlot)) {
      slot.release();
    }

    const granted = await Promise.race([queued[0], queued[1]]);
    expect(isSlot(granted as HashSlot | "overloaded")).toBe(true);
    expect(limiter.running).toBe(2);
    expect(limiter.queued).toBe(6);
  });

  it("overloads a waiter after 5 seconds in the queue", async () => {
    vi.useFakeTimers();
    const limiter = new HashLimiter();
    await limiter.acquire();
    await limiter.acquire();
    const waiting = limiter.acquire();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(limiter.queued).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toBe("overloaded");
    expect(limiter.queued).toBe(0);
  });

  it("hands a released slot to the next waiter in order, and release is idempotent", async () => {
    const limiter = new HashLimiter({ maxRunning: 1 });
    const first = (await limiter.acquire()) as HashSlot;
    const order: string[] = [];
    const a = limiter.acquire().then(() => order.push("a"));
    const b = limiter.acquire().then(() => order.push("b"));

    first.release();
    first.release();
    await a;

    expect(order).toEqual(["a"]);
    expect(limiter.running).toBe(1);
    expect(limiter.queued).toBe(1);
    void b;
  });
});
