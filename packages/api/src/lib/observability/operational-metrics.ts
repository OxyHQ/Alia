/**
 * The operational gauges: what an operator needs to see that background work is flowing, read at
 * scrape time from the stores that hold it (`GET /internal/metrics`).
 *
 * The in-memory registry (`metrics.ts`) counts what THIS process did and is lost on restart; these are
 * facts about the system (a backlog, a stuck event, a queue's depth) and are true whichever instance
 * answers. Each is one cheap, indexed count.
 */

import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { agentInboxItems } from '../../db/schema/agent-runtime.js';
import { automationEvents } from '../../db/schema/agency.js';
import { channelInbound } from '../../db/schema/bots.js';
import type { ApiDatabase } from '../../db/index.js';

export interface OperationalGauge {
  name: string;
  help: string;
  value: number;
  labels?: Record<string, string>;
}

/** Past these a row is not "in flight": the matching sweep should have taken it. */
export const STALLED_EVENT_AFTER_MS = 2 * 60_000;
export const STALLED_INBOUND_AFTER_MS = 2 * 60_000;

const count = async (query: PromiseLike<Array<{ n: number }>>): Promise<number> =>
  (await query)[0]?.n ?? 0;

/** Every gauge, from the database. A failed read is left out rather than reported as zero. */
export async function databaseGauges(
  db: Pick<ApiDatabase, 'select'>,
  now: Date = new Date(),
): Promise<OperationalGauge[]> {
  const eventCutoff = new Date(now.getTime() - STALLED_EVENT_AFTER_MS);
  const inboundCutoff = new Date(now.getTime() - STALLED_INBOUND_AFTER_MS);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
  const reads: Array<[string, string, Promise<number>]> = [
    [
      'alia_automation_events_stalled',
      'Oxy events accepted but not dispatched for over two minutes (a sweep should take them).',
      count(
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(automationEvents)
          .where(
            and(
              inArray(automationEvents.status, ['received', 'matched']),
              lt(automationEvents.updatedAt, eventCutoff),
              gt(automationEvents.receivedAt, dayAgo),
            ),
          ),
      ),
    ],
    [
      'alia_channel_inbound_stalled',
      'Messaging-platform messages stored but not answered for over two minutes.',
      count(
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(channelInbound)
          .where(
            and(
              inArray(channelInbound.status, ['received', 'processing']),
              lt(channelInbound.updatedAt, inboundCutoff),
            ),
          ),
      ),
    ],
    [
      'alia_channel_inbound_failed_total',
      'Messaging-platform messages that could not be answered (kept for an hour).',
      count(
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(channelInbound)
          .where(eq(channelInbound.status, 'failed')),
      ),
    ],
    [
      'alia_agent_inbox_pending',
      'Items waiting in agents’ inboxes for a heartbeat to deliver them.',
      count(
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(agentInboxItems)
          .where(eq(agentInboxItems.status, 'pending')),
      ),
    ],
  ];
  const settled = await Promise.allSettled(reads.map(([, , value]) => value));
  return reads.flatMap(([name, help], index) => {
    const result = settled[index];
    return result?.status === 'fulfilled' ? [{ name, help, value: result.value }] : [];
  });
}

/** BullMQ job counts as gauges, one per (queue, state). Nothing without Redis. */
export function queueGauges(
  queues: ReadonlyArray<{ queue: string; counts: Record<string, number> | null }>,
): OperationalGauge[] {
  return queues.flatMap(({ queue, counts }) =>
    Object.entries(counts ?? {}).map(([state, value]) => ({
      name: 'alia_queue_jobs',
      help: 'BullMQ jobs by queue and state.',
      value,
      labels: { queue, state },
    })),
  );
}

const escapeLabel = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Prometheus text exposition for a list of gauges (one HELP/TYPE per name). */
export function renderGauges(gauges: readonly OperationalGauge[]): string {
  const lines: string[] = [];
  const declared = new Set<string>();
  for (const gauge of gauges) {
    if (!declared.has(gauge.name)) {
      declared.add(gauge.name);
      lines.push(`# HELP ${gauge.name} ${gauge.help}`, `# TYPE ${gauge.name} gauge`);
    }
    const labels = gauge.labels
      ? `{${Object.entries(gauge.labels)
          .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
          .join(',')}}`
      : '';
    lines.push(`${gauge.name}${labels} ${gauge.value}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface MetricsSources {
  readonly db: Pick<ApiDatabase, 'select'>;
  /** What this process counted (`metrics.ts`). */
  readonly processMetrics: () => string;
  readonly queues: ReadonlyArray<{
    queue: string;
    counts: () => Promise<Record<string, number> | null>;
  }>;
  readonly now?: Date;
}

/**
 * The whole `/internal/metrics` body. A queue that cannot be counted (Redis down) is left out; the
 * rest still answers, because a monitor that dies when Redis does cannot say that Redis died.
 */
export async function renderOperationalMetrics(sources: MetricsSources): Promise<string> {
  const [database, counted] = await Promise.all([
    databaseGauges(sources.db, sources.now),
    Promise.all(
      sources.queues.map(async ({ queue, counts }) => ({
        queue,
        counts: await counts().catch(() => null),
      })),
    ),
  ]);
  return `${sources.processMetrics()}\n${renderGauges([...database, ...queueGauges(counted)])}`;
}
