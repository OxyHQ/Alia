import { describe, expect, it } from 'vitest';
import {
  lockedFeatureOf,
  parseConsultEvent,
  parseHostAction,
} from '../../src/runtime/stream-events';

/** The consult, host-action and feature-gate frames of `docs/agent-embedding.md`, read strictly. */

const v1 = (payload: Record<string, unknown>) => ({ eventVersion: 1, consultId: 'k1', ...payload });

describe('parseConsultEvent', () => {
  it('reads each of the four frames', () => {
    expect(
      parseConsultEvent(
        'alia.agent_start',
        v1({
          agent: { id: 'a', name: 'Sindi', handle: 'sindibot', color: 'teal', character: { x: 1 } },
          task: 'find',
        }),
      ),
    ).toEqual({
      type: 'start',
      consultId: 'k1',
      agent: { id: 'a', name: 'Sindi', handle: 'sindibot', color: 'teal', character: { x: 1 } },
      task: 'find',
    });
    expect(parseConsultEvent('alia.agent_delta', v1({ content: 'hi' }))).toEqual({
      type: 'delta',
      consultId: 'k1',
      content: 'hi',
    });
    expect(
      parseConsultEvent(
        'alia.agent_tool',
        v1({ phase: 'result', toolCallId: 't', name: 'oxy_homiio__x', output: [1] }),
      ),
    ).toEqual({
      type: 'tool',
      consultId: 'k1',
      phase: 'result',
      toolCallId: 't',
      name: 'oxy_homiio__x',
      output: [1],
    });
    expect(
      parseConsultEvent(
        'alia.agent_end',
        v1({ status: 'failed', error: { code: 'out_of_reach' } }),
      ),
    ).toEqual({ type: 'end', consultId: 'k1', status: 'failed', errorCode: 'out_of_reach' });
  });

  it('refuses another version, a frame without its consult, and missing or mistyped fields', () => {
    const start = { agent: { id: 'a', name: 'Sindi' } };
    expect(parseConsultEvent('alia.agent_start', { ...v1(start), eventVersion: 2 })).toBeNull();
    expect(parseConsultEvent('alia.agent_start', { eventVersion: 1, ...start })).toBeNull();
    expect(parseConsultEvent('alia.agent_start', v1({ agent: { id: 'a' } }))).toBeNull();
    expect(parseConsultEvent('alia.agent_delta', v1({ content: 3 }))).toBeNull();
    expect(
      parseConsultEvent('alia.agent_tool', v1({ phase: 'done', toolCallId: 't', name: 'x' })),
    ).toBeNull();
    expect(
      parseConsultEvent(
        'alia.agent_tool',
        v1({ phase: 'call', toolCallId: 't', name: 'x', input: 'not an object' }),
      ),
    ).toBeNull();
    expect(parseConsultEvent('alia.agent_end', v1({ status: 'ok' }))).toBeNull();
    expect(parseConsultEvent('alia.agent_end', v1({ status: 'completed', content: 1 }))).toBeNull();
  });

  it('reads nothing from the retired single `alia.agent` frame', () => {
    expect(
      parseConsultEvent('alia.agent', {
        eventVersion: 1,
        agentId: 'a',
        agentName: 'A',
        content: 'x',
      }),
    ).toBeNull();
  });
});

describe('parseHostAction', () => {
  it('reads an action, and an absent input as an empty one', () => {
    expect(
      parseHostAction({ eventVersion: 1, toolCallId: 'c', app: 'homiio', name: 'apply_search' }),
    ).toEqual({ toolCallId: 'c', app: 'homiio', name: 'apply_search', input: {} });
  });

  it('keeps an awaited action’s turn, and refuses one that cannot be answered', () => {
    const awaited = { eventVersion: 1, toolCallId: 'c', app: 'astro', name: 'read_tab' };
    expect(parseHostAction({ ...awaited, awaitsResult: true, turnId: 't-1' })).toEqual({
      toolCallId: 'c',
      app: 'astro',
      name: 'read_tab',
      input: {},
      awaitsResult: true,
      turnId: 't-1',
    });
    expect(parseHostAction({ ...awaited, awaitsResult: true })).toBeNull();
    expect(parseHostAction({ ...awaited, awaitsResult: 'yes', turnId: 't-1' })).toBeNull();
    expect(parseHostAction({ ...awaited, turnId: 't-1' })).toEqual({
      toolCallId: 'c',
      app: 'astro',
      name: 'read_tab',
      input: {},
    });
  });

  it('refuses one without its call, app or name, or another version', () => {
    expect(parseHostAction({ eventVersion: 1, app: 'homiio', name: 'x' })).toBeNull();
    expect(parseHostAction({ eventVersion: 1, toolCallId: 'c', name: 'x' })).toBeNull();
    expect(parseHostAction({ eventVersion: 2, toolCallId: 'c', app: 'a', name: 'x' })).toBeNull();
    expect(
      parseHostAction({ eventVersion: 1, toolCallId: 'c', app: 'a', name: 'x', input: [] }),
    ).toBeNull();
  });
});

describe('lockedFeatureOf', () => {
  it('names the feature of a gate’s refusal and nothing else', () => {
    expect(
      lockedFeatureOf({ code: 'feature_entitlement_required', feature: 'attachments.documents' }),
    ).toBe('attachments.documents');
    expect(lockedFeatureOf({ code: 'INSUFFICIENT_CREDITS' })).toBeNull();
    expect(lockedFeatureOf({ code: 'feature_entitlement_required' })).toBeNull();
    expect(lockedFeatureOf('feature_entitlement_required')).toBeNull();
  });
});
