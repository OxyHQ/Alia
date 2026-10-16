import { describe, expect, it } from 'vitest';
import {
  type AgentActivityEvent,
  applyActivityEvent,
  hydrateActivity,
  INITIAL_ACTIVITY,
  MAX_ACTIVITY_EVENTS,
} from '../../src/runtime/thread/agent-activity';

/**
 * What an agent's run adds up to as its events arrive, and as it is picked up halfway. The card in
 * the thread and a task's timeline both read this, so a wrong sum is a wrong card.
 */

const event = (
  type: AgentActivityEvent['type'],
  extra: Partial<AgentActivityEvent> = {},
): AgentActivityEvent => ({ type, content: '', timestamp: 1_000, sessionId: 's1', ...extra });

const run = (...events: AgentActivityEvent[]) =>
  events.reduce(applyActivityEvent, INITIAL_ACTIVITY);

describe('applyActivityEvent', () => {
  it('counts every event and remembers when the first one came', () => {
    const state = run(event('thinking', { timestamp: 5 }), event('thinking', { timestamp: 9 }));
    expect(state.eventCount).toBe(2);
    expect(state.startedAt).toBe(5);
  });

  it('shows the tool being used until its result lands', () => {
    const during = run(
      event('tool_call', { content: 'looking', metadata: { toolName: 'browser' } }),
    );
    expect(during.currentAction).toEqual({ toolName: 'browser', content: 'looking' });
    expect(applyActivityEvent(during, event('tool_result')).currentAction).toBeNull();
  });

  it('takes the plan as the latest one reported', () => {
    const plan = { items: [{ id: 1, text: 'a', status: 'completed' }], completed: 1, total: 1 };
    expect(run(event('plan_progress', { data: { plan } })).plan).toBe(plan);
  });

  it('ends on an error with its words, and on completion with no answer left pending', () => {
    const failed = run(
      event('response', { content: 'partial' }),
      event('error', { content: 'boom' }),
    );
    expect(failed).toMatchObject({ hasError: true, lastError: 'boom', currentAction: null });

    const done = run(event('response', { content: 'answer' }), event('complete'));
    expect(done).toMatchObject({ isComplete: true, latestResponse: null });
  });

  it('lists each source once, by its address', () => {
    const found = (url: string) =>
      event('source_found', { content: 'snippet', metadata: { url, title: 'T' } });
    const state = run(
      found('https://a.test/x'),
      found('https://a.test/x'),
      found('https://b.test/y'),
    );
    expect(state.sources.map((source) => [source.url, source.domain])).toEqual([
      ['https://a.test/x', 'a.test'],
      ['https://b.test/y', 'b.test'],
    ]);
  });

  it('keeps the last events and no more', () => {
    const many = Array.from({ length: MAX_ACTIVITY_EVENTS + 10 }, (_, i) =>
      event('thinking', { timestamp: i }),
    );
    const state = run(...many);
    expect(state.events).toHaveLength(MAX_ACTIVITY_EVENTS);
    expect(state.events[0]?.timestamp).toBe(10);
    expect(state.eventCount).toBe(MAX_ACTIVITY_EVENTS + 10);
  });
});

describe('hydrateActivity', () => {
  it('reads the stored events as the live ones they were', () => {
    const state = hydrateActivity(
      INITIAL_ACTIVITY,
      {
        recentEvents: [
          { type: 'action', content: 'go', timestamp: 3, metadata: { toolName: 'browser' } },
          { type: 'observation', content: 'seen', timestamp: 4 },
          { type: 'threat_detected', content: 'hmm', timestamp: 5 },
          { type: 'user_message', content: 'hi', timestamp: 6 },
        ],
      },
      's1',
    );
    expect(state.events.map((e) => e.type)).toEqual([
      'tool_call',
      'tool_result',
      'threat',
      'system',
    ]);
    expect(state.events.every((e) => e.sessionId === 's1')).toBe(true);
    expect(state.startedAt).toBe(3);
    expect(state.eventCount).toBe(4);
  });

  it('counts the plan’s completed items and reads how the session ended', () => {
    const items = [
      { id: 1, text: 'a', status: 'completed' },
      { id: 2, text: 'b', status: 'pending' },
    ];
    const state = hydrateActivity(
      INITIAL_ACTIVITY,
      {
        session: {
          plan: { items },
          status: 'completed',
          result: 'done',
          stats: { creditsCharged: 4 },
        },
      },
      's1',
    );
    expect(state.plan).toEqual({ items, completed: 1, total: 2 });
    expect(state).toMatchObject({
      isComplete: true,
      hasError: false,
      latestResponse: 'done',
      creditsCharged: 4,
    });
  });

  it('says a failed session failed, with the reason it left', () => {
    const state = hydrateActivity(
      INITIAL_ACTIVITY,
      { session: { status: 'failed', result: 'out of steps' } },
      's1',
    );
    expect(state).toMatchObject({ hasError: true, lastError: 'out of steps', isComplete: false });
  });

  it('keeps what the socket already told it when the status has nothing', () => {
    const live = run(
      event('plan_progress', { data: { plan: { items: [], completed: 0, total: 0 } } }),
    );
    const state = hydrateActivity(live, {}, 's1');
    expect(state.plan).toBe(live.plan);
  });
});
