import type { ArchetypeConfig, RoutingRule } from '@/lib/types/agents';

/**
 * Edits of an archetype's configuration, as pure functions of the config.
 *
 * Each returns the WHOLE next config, because the editor writes the config as
 * one field of its draft: a patch that dropped a sibling key would save it
 * dropped.
 */

/** One channel on or off in a multi-select list of the config. */
export function withChannelToggled(
  config: ArchetypeConfig,
  key: 'deliveryChannels' | 'inboundChannels',
  channel: string,
): ArchetypeConfig {
  const channels = config[key] || [];
  return {
    ...config,
    [key]: channels.includes(channel)
      ? channels.filter((c: string) => c !== channel)
      : [...channels, channel],
  };
}

/** A routing rule's fields, rewritten in place. */
export function withRoutingRuleEdited(
  config: ArchetypeConfig,
  index: number,
  patch: Partial<RoutingRule>,
): ArchetypeConfig {
  const rules = [...(config.routingRules || [])];
  rules[index] = { ...rules[index], ...patch };
  return { ...config, routingRules: rules };
}

/** A new, empty routing rule at the end of the list. */
export function withRoutingRuleAdded(config: ArchetypeConfig): ArchetypeConfig {
  return {
    ...config,
    routingRules: [
      ...(config.routingRules || []),
      {
        condition: '',
        priority: 'medium',
        assignTo: { type: 'user', id: '', name: '' },
      },
    ],
  };
}

/** The routing rule at `index`, gone. */
export function withRoutingRuleRemoved(
  config: ArchetypeConfig,
  index: number,
): ArchetypeConfig {
  return {
    ...config,
    routingRules: (config.routingRules || []).filter((_, i) => i !== index),
  };
}

/** A segmented control's value, as a rule priority; anything unknown is medium. */
export function routingPriorityFrom(value: string): RoutingRule['priority'] {
  return value === 'low'
    ? 'low'
    : value === 'high'
      ? 'high'
      : value === 'urgent'
        ? 'urgent'
        : 'medium';
}
