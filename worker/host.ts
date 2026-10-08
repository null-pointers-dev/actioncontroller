import { claim, finish, retry, type QueueName } from '@/server/core/platform/queue';
import { acquireLease, releaseLease } from '@/server/core/platform/leases';
import type { StepResult } from '@/server/core/runs/dispatch';

export interface QueueConsumer {
  queue: QueueName;
  concurrency: number;
  handle(key: string, attempts: number): Promise<StepResult | void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs queue consumers: claim (SKIP LOCKED) -> handle -> finish / retry. */
export class WorkerHost {
  private running = false;
  private readonly consumers: QueueConsumer[] = [];
  private readonly active = new Map<QueueName, number>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly workerId: string) {}

  register(consumer: QueueConsumer): this {
    this.consumers.push(consumer);
    return this;
  }

  start(): void {
    this.running = true;
    for (const c of this.consumers) void this.loop(c);
  }

  private async loop(c: QueueConsumer): Promise<void> {
    while (this.running) {
      const free = c.concurrency - (this.active.get(c.queue) ?? 0);
      let claimed = 0;
      if (free > 0) {
        try {
          const items = await claim(c.queue, this.workerId, free);
          claimed = items.length;
          for (const item of items) this.track(this.process(c, item.key, item.attempts));
        } catch (err) {
          console.error(`[worker] claim ${c.queue} failed`, (err as Error).message);
          await sleep(5_000);
        }
      }
      await sleep(claimed > 0 ? 50 : 1_000);
    }
  }

  private track(p: Promise<void>) {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  private async process(c: QueueConsumer, key: string, attempts: number): Promise<void> {
    this.active.set(c.queue, (this.active.get(c.queue) ?? 0) + 1);
    try {
      const result = await c.handle(key, attempts);
      if (result && 'retryAfterSeconds' in result) {
        await retry(c.queue, key, this.workerId, result.reason, result.retryAfterSeconds);
      } else {
        await finish(c.queue, key, this.workerId);
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      console.error(`[worker] ${c.queue}:${key} failed (attempt ${attempts})`, message);
      await retry(c.queue, key, this.workerId, message.slice(0, 1000)).catch(() => undefined);
    } finally {
      this.active.set(c.queue, (this.active.get(c.queue) ?? 1) - 1);
    }
  }

  /** Graceful shutdown: stop claiming, let in-flight steps finish. */
  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled([...this.inflight]);
  }
}

/** Periodic jobs that must run on one instance at a time (lease with fencing token). */
export class LeasedScheduler {
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly busy = new Set<string>();
  private readonly held = new Set<string>();

  constructor(private readonly holder: string) {}

  every(name: string, intervalMs: number, job: () => Promise<unknown>): this {
    const ttlSeconds = Math.max(30, Math.ceil((intervalMs * 3) / 1000));
    const tick = async () => {
      if (this.busy.has(name)) return;
      this.busy.add(name);
      try {
        const token = await acquireLease(`scheduler:${name}`, this.holder, ttlSeconds);
        if (token === null) return;
        this.held.add(name);
        await job();
      } catch (err) {
        console.error(`[scheduler] ${name} failed`, (err as Error).message);
      } finally {
        this.busy.delete(name);
      }
    };
    void tick();
    this.timers.push(setInterval(() => void tick(), intervalMs));
    return this;
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    await Promise.allSettled([...this.held].map((n) => releaseLease(`scheduler:${n}`, this.holder)));
  }
}

/** A loop with its own cadence (webhook processing). */
export function repeat(name: string, intervalMs: number, job: () => Promise<number>): { stop: () => void } {
  let running = true;
  void (async () => {
    while (running) {
      let processed = 0;
      try {
        processed = await job();
      } catch (err) {
        console.error(`[worker] ${name} failed`, (err as Error).message);
      }
      await sleep(processed > 0 ? 20 : intervalMs);
    }
  })();
  return { stop: () => (running = false) };
}
