import { describe, expect, it } from 'vitest';
import {
  routingPriorityFrom,
  withChannelToggled,
  withRoutingRuleAdded,
  withRoutingRuleEdited,
  withRoutingRuleRemoved,
} from '../archetype-config';
import type { ArchetypeConfig } from '../../types/agents';

/**
 * The archetype edits the agent editor writes as ONE field of its draft.
 *
 * What matters for each is the whole config it returns: the editor saves that
 * object as is, so a sibling key the edit dropped is a key the save deletes.
 */

const BASE: ArchetypeConfig = {
  citeSources: false,
  deliveryChannels: ['email'],
  routingRules: [
    { condition: 'billing', priority: 'high', assignTo: { type: 'user', id: 'u1', name: 'Ana' } },
    { condition: 'bugs', priority: 'low', assignTo: { type: 'team', id: 't1', name: 'Eng' } },
  ],
};

describe('withChannelToggled', () => {
  it('adds a channel that was off and removes one that was on, keeping the rest', () => {
    const on = withChannelToggled(BASE, 'deliveryChannels', 'slack');
    expect(on.deliveryChannels).toEqual(['email', 'slack']);
    expect(on.citeSources).toBe(false);
    expect(on.routingRules).toBe(BASE.routingRules);

    const off = withChannelToggled(on, 'deliveryChannels', 'email');
    expect(off.deliveryChannels).toEqual(['slack']);
  });

  it('starts a list that did not exist yet', () => {
    expect(withChannelToggled({}, 'inboundChannels', 'github').inboundChannels).toEqual(['github']);
  });

  it('never mutates the config it was given', () => {
    withChannelToggled(BASE, 'deliveryChannels', 'email');
    expect(BASE.deliveryChannels).toEqual(['email']);
  });
});

describe('routing rules', () => {
  it('edits one rule in place and leaves the others alone', () => {
    const next = withRoutingRuleEdited(BASE, 1, { condition: 'outages' });
    expect(next.routingRules?.[1]).toEqual({ ...BASE.routingRules![1], condition: 'outages' });
    expect(next.routingRules?.[0]).toBe(BASE.routingRules![0]);
    expect(BASE.routingRules![1].condition).toBe('bugs');
  });

  it('appends an empty medium-priority rule', () => {
    const next = withRoutingRuleAdded(BASE);
    expect(next.routingRules).toHaveLength(3);
    expect(next.routingRules?.[2]).toEqual({
      condition: '',
      priority: 'medium',
      assignTo: { type: 'user', id: '', name: '' },
    });
    expect(withRoutingRuleAdded({}).routingRules).toHaveLength(1);
  });

  it('removes exactly the rule at the index', () => {
    const next = withRoutingRuleRemoved(BASE, 0);
    expect(next.routingRules?.map((rule) => rule.condition)).toEqual(['bugs']);
    expect(next.deliveryChannels).toEqual(['email']);
  });
});

describe('segmented-control values', () => {
  it('reads a priority, and anything unknown as medium', () => {
    expect(routingPriorityFrom('low')).toBe('low');
    expect(routingPriorityFrom('high')).toBe('high');
    expect(routingPriorityFrom('urgent')).toBe('urgent');
    expect(routingPriorityFrom('medium')).toBe('medium');
    expect(routingPriorityFrom('whatever')).toBe('medium');
  });
});
