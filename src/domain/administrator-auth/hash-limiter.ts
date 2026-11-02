/**
 * The bounded password-hashing limiter (`ADR-004` P-7, issue #258).
 *
 * **At most 2 running, at most 8 waiting, each waiting at most 5 seconds**; past any of those
 * bounds, `acquire` resolves to `"overloaded"`. The caller turns that into the generic
 * "try again later" response, which is **not counted** as a failure and is the same for known
 * and unknown accounts. Mapping it to HTTP 503 with `Retry-After` is the journey slice's work.
 *
 * The limit is **per process** (`ADR-004`): each instance of this class is one limiter, and
 * `ADR-028` D-17's bound is stated per instance. A slot must be held until a failed
 * verification's accounting has committed (`sign-in.ts`); `release` is idempotent so that a
 * `finally` can always call it.
 */

export const HASH_LIMITER_MAX_RUNNING = 2;
export const HASH_LIMITER_MAX_QUEUED = 8;
export const HASH_LIMITER_QUEUE_TIMEOUT_MS = 5_000;

export interface HashSlot {
  release(): void;
}

export interface HashLimiterOptions {
  readonly maxRunning?: number;
  readonly maxQueued?: number;
  readonly queueTimeoutMs?: number;
}

interface Waiter {
  readonly grant: (slot: HashSlot) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class HashLimiter {
  readonly maxRunning: number;
  readonly maxQueued: number;
  readonly queueTimeoutMs: number;

  #running = 0;
  readonly #queue: Waiter[] = [];

  constructor(options: HashLimiterOptions = {}) {
    this.maxRunning = options.maxRunning ?? HASH_LIMITER_MAX_RUNNING;
    this.maxQueued = options.maxQueued ?? HASH_LIMITER_MAX_QUEUED;
    this.queueTimeoutMs = options.queueTimeoutMs ?? HASH_LIMITER_QUEUE_TIMEOUT_MS;
  }

  get running(): number {
    return this.#running;
  }

  get queued(): number {
    return this.#queue.length;
  }

  acquire(): Promise<HashSlot | "overloaded"> {
    if (this.#running < this.maxRunning && this.#queue.length === 0) {
      this.#running += 1;
      return Promise.resolve(this.#slot());
    }

    if (this.#queue.length >= this.maxQueued) {
      return Promise.resolve("overloaded");
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        grant: (slot) => resolve(slot),
        timer: setTimeout(() => {
          const index = this.#queue.indexOf(waiter);

          if (index >= 0) {
            this.#queue.splice(index, 1);
            resolve("overloaded");
          }
        }, this.queueTimeoutMs),
      };

      this.#queue.push(waiter);
    });
  }

  #slot(): HashSlot {
    let released = false;

    return {
      release: () => {
        if (released) {
          return;
        }

        released = true;
        const next = this.#queue.shift();

        if (next === undefined) {
          this.#running -= 1;
          return;
        }

        // The slot passes straight to the next waiter, so `running` never dips and a new
        // arrival cannot overtake the queue.
        clearTimeout(next.timer);
        next.grant(this.#slot());
      },
    };
  }
}
