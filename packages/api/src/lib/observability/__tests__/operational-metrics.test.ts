import { describe, expect, it } from 'vitest';
import { queueGauges, renderGauges, renderOperationalMetrics } from '../operational-metrics.js';

describe('renderGauges', () => {
  it('declares each name once and writes one line per sample, with labels', () => {
    const text = renderGauges([
      {
        name: 'alia_queue_jobs',
        help: 'Jobs.',
        value: 3,
        labels: { queue: 'a', state: 'waiting' },
      },
      { name: 'alia_queue_jobs', help: 'Jobs.', value: 0, labels: { queue: 'a', state: 'failed' } },
      { name: 'alia_agent_inbox_pending', help: 'Waiting.', value: 7 },
    ]);
    expect(text.match(/# TYPE alia_queue_jobs gauge/g)).toHaveLength(1);
    expect(text).toContain('alia_queue_jobs{queue="a",state="waiting"} 3');
    expect(text).toContain('alia_queue_jobs{queue="a",state="failed"} 0');
    expect(text).toContain('# HELP alia_agent_inbox_pending Waiting.');
    expect(text).toContain('alia_agent_inbox_pending 7\n');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('escapes a label value so it cannot break the line or forge another', () => {
    const text = renderGauges([{ name: 'g', help: 'h', value: 1, labels: { queue: 'a"b\\c' } }]);
    expect(text).toContain('g{queue="a\\"b\\\\c"} 1');
  });

  it('is only a newline for no gauges', () => {
    expect(renderGauges([])).toBe('\n');
  });
});

describe('queueGauges', () => {
  it('has one gauge per queue and state, and nothing for a queue that has no Redis', () => {
    const gauges = queueGauges([
      { queue: 'agent-sessions', counts: { waiting: 2, active: 1 } },
      { queue: 'alia-tasks', counts: null },
    ]);
    expect(gauges.map((g) => [g.labels?.queue, g.labels?.state, g.value])).toEqual([
      ['agent-sessions', 'waiting', 2],
      ['agent-sessions', 'active', 1],
    ]);
  });
});

describe('renderOperationalMetrics', () => {
  /** A database that answers every count with 4. */
  const db = {
    select: () => ({ from: () => ({ where: async () => [{ n: 4 }] }) }),
  } as unknown as Parameters<typeof renderOperationalMetrics>[0]['db'];

  it('puts the process metrics first, then the gauges and the queue depths', async () => {
    const body = await renderOperationalMetrics({
      db,
      processMetrics: () => '# process\nalia_chat_requests 9',
      queues: [{ queue: 'alia-tasks', counts: async () => ({ waiting: 5 }) }],
    });
    expect(body.startsWith('# process\nalia_chat_requests 9\n')).toBe(true);
    expect(body).toContain('alia_queue_jobs{queue="alia-tasks",state="waiting"} 5');
    expect(body).toContain('alia_agent_inbox_pending 4');
  });

  it('still answers when a queue cannot be counted', async () => {
    const body = await renderOperationalMetrics({
      db,
      processMetrics: () => '',
      queues: [
        {
          queue: 'agent-sessions',
          counts: async () => {
            throw new Error('redis down');
          },
        },
        { queue: 'alia-tasks', counts: async () => ({ active: 1 }) },
      ],
    });
    expect(body).not.toContain('agent-sessions');
    expect(body).toContain('alia_queue_jobs{queue="alia-tasks",state="active"} 1');
  });
});
