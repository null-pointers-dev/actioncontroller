import 'server-only';
import { sql } from 'drizzle-orm';
import type { EventType, LiveEvent } from '@/shared/events';
import { getDb } from '@/server/db/client';

export interface FeedCursor {
  txid: string;
  seq: number;
}

interface RawEventRow {
  seq: string;
  txid: string;
  id: string;
  type: string;
  occurred_at: Date;
  subject: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string | null;
  actor_kind: string;
  actor_id: string | null;
  workspace_id: string | null;
  workflow_id: string | null;
  data: Record<string, unknown>;
}

export interface FeedEvent extends LiveEvent {
  cursor: FeedCursor;
  actorKind: string;
  actorId: string | null;
}

export function encodeCursor(c: FeedCursor): string {
  return Buffer.from(`${c.txid}:${c.seq}`).toString('base64url');
}

export function decodeCursor(value: string | null | undefined): FeedCursor | null {
  if (!value) return null;
  const [txid, seq] = Buffer.from(value, 'base64url').toString('utf8').split(':');
  if (!txid || !seq || !/^\d+$/.test(txid) || !/^\d+$/.test(seq)) return null;
  return { txid, seq: Number(seq) };
}

/** The newest commit-safe position: subscribers starting "now" begin here. */
export async function headCursor(): Promise<FeedCursor> {
  const res = await getDb().execute<{ txid: string; seq: string }>(sql`
    select txid::text as txid, seq::text as seq from cp.events
     where txid < pg_snapshot_xmin(pg_current_snapshot())
     order by txid desc, seq desc limit 1`);
  const row = res.rows[0];
  return row ? { txid: row.txid, seq: Number(row.seq) } : { txid: '0', seq: 0 };
}

/** Commit-safe read after a cursor (never skips an event). */
export async function readEvents(after: FeedCursor, limit = 200): Promise<FeedEvent[]> {
  const res = await getDb().execute<RawEventRow>(sql`
    select seq::text, txid::text, id, type, occurred_at, subject, aggregate_type, aggregate_id,
           aggregate_version::text, actor_kind, actor_id, workspace_id, workflow_id::text, data
      from cp.read_events(${after.txid}::xid8, ${after.seq}, ${limit})`);
  return res.rows.map((r) => ({
    cursor: { txid: r.txid, seq: Number(r.seq) },
    id: r.id,
    type: r.type as EventType,
    time: new Date(r.occurred_at).toISOString(),
    subject: r.subject,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    aggregateVersion: r.aggregate_version === null ? null : Number(r.aggregate_version),
    workspaceId: r.workspace_id,
    workflowId: r.workflow_id === null ? null : Number(r.workflow_id),
    actorKind: r.actor_kind,
    actorId: r.actor_id,
    data: r.data,
  }));
}

export async function eventsForAggregate(aggregateType: string, aggregateId: string, limit = 200) {
  const res = await getDb().execute<RawEventRow>(sql`
    select seq::text, txid::text, id, type, occurred_at, subject, aggregate_type, aggregate_id,
           aggregate_version::text, actor_kind, actor_id, workspace_id, workflow_id::text, data
      from cp.events
     where aggregate_type = ${aggregateType} and aggregate_id = ${aggregateId}
     order by occurred_at, seq
     limit ${limit}`);
  return res.rows.map((r) => ({
    id: r.id,
    type: r.type,
    time: new Date(r.occurred_at).toISOString(),
    actorKind: r.actor_kind,
    actorId: r.actor_id,
    data: r.data,
  }));
}
