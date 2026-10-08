import 'server-only';
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { createListenClient } from '../db/client';

/**
 * One per web process (docs/05 §3). Postgres NOTIFY is the doorbell; the in-process
 * EventEmitter only fans the ring out to this process's open SSE subscriptions.
 * Subscribers always read events from cp.events, so nothing is lost if a ring is missed.
 */
class EventHub {
  private readonly emitter = new EventEmitter();
  private client: pg.Client | null = null;
  private starting: Promise<void> | null = null;
  private fallback: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  start(): Promise<void> {
    this.starting ??= this.connect();
    return this.starting;
  }

  private async connect(): Promise<void> {
    try {
      const client = await createListenClient();
      client.on('notification', () => this.ring());
      const lost = (err?: unknown) => {
        if (err) console.warn('[event-hub] LISTEN connection lost', (err as Error).message);
        this.client = null;
        this.starting = null;
        this.startFallback();
        setTimeout(() => void this.start(), 2_000);
      };
      client.on('error', lost);
      client.on('end', () => lost());
      await client.query('LISTEN cp_events');
      this.client = client;
      this.stopFallback();
    } catch (err) {
      console.warn('[event-hub] cannot LISTEN, polling every 2s', (err as Error).message);
      this.starting = null;
      this.startFallback();
      setTimeout(() => void this.start(), 5_000);
    }
  }

  private startFallback() {
    this.fallback ??= setInterval(() => this.emitter.emit('change'), 2_000);
  }

  private stopFallback() {
    if (this.fallback) clearInterval(this.fallback);
    this.fallback = null;
  }

  /** Coalesce bursts of notifications (~25 ms). */
  private ring() {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.emitter.emit('change');
    }, 25);
  }

  /** Resolves on the next change, on timeout, or when the subscriber disconnects. */
  waitForChange(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.emitter.off('change', finish);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.emitter.on('change', finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }
}

const globals = globalThis as typeof globalThis & { __cpEventHub?: EventHub };
export function getEventHub(): EventHub {
  globals.__cpEventHub ??= new EventHub();
  return globals.__cpEventHub;
}
