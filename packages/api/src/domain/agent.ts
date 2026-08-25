/**
 * Closed value sets for `agent`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

export const AGENT_ARCHETYPES = ['general', 'qa', 'task_router', 'status_update'] as const;
export type AgentArchetype = (typeof AGENT_ARCHETYPES)[number];
/**
 * Exported as a TUPLE for the same reason `AGENT_ARCHETYPES` already is: the
 * Postgres schema renders its CHECK from this exact value rather than retyping
 * it, so the constraint and this validator cannot drift apart.
 */
export const AGENT_STATUSES = ['active', 'idle', 'offline'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * Who may USE an agent — a different question from whether it is listed.
 *
 * `is_published` answers "does it appear in the catalogue", and until now it
 * answered both: anything published could be used by anyone, so "let people
 * find it" and "let people run it" were one switch and the useful combination
 * — listed, but mine to lend — could not be expressed.
 *
 *  - `private` — its owner, and whoever holds a membership on its bot account.
 *    Sharing IS adding a member, which is what "hiring" became.
 *  - `public` — anyone.
 *
 * The default is `private`, matching the account the agent is born with, which
 * is created opted out of discovery.
 */
export const AGENT_ACCESS = ['private', 'public'] as const;
export type AgentAccess = (typeof AGENT_ACCESS)[number];

/**
 * `archetype_config`, and the ONE place its stored shape is narrowed.
 *
 * The column is `jsonb` and nothing validates it on the way in: it holds a union
 * of four archetypes' settings, selected by `archetype`, and no writer checks
 * that the two agree. So the repository types it `unknown` — which is honest —
 * and every reader narrows through {@link readArchetypeConfig} rather than
 * asserting a shape onto it.
 *
 * The narrowing lives here, beside the archetype vocabulary that selects it, and
 * NOT in the schema as a `$type<…>()`: a `$type` would tell `tsc` the stored
 * value has this shape, which is exactly the claim nothing enforces. Three
 * readers used to share the Mongoose interface `IArchetypeConfig` and got the
 * same false guarantee from it.
 */
export interface ArchetypeAssignee {
  type?: string;
  id?: string;
  name?: string;
}

export interface ArchetypeRoutingRule {
  condition?: string;
  priority?: string;
  assignTo?: ArchetypeAssignee;
}

export interface ArchetypeSchedule {
  type?: string;
  time?: string;
  days?: string[];
  intervalMinutes?: number;
  cron?: string;
}

/**
 * `knowledgeSources` and `dataSources` were here, and they are GONE.
 *
 * Two identically shaped lists of integration, MCP-server and Oxy-service names
 * — the third of the three vocabularies that answered "what may this agent
 * touch", and the only one that never even claimed to reach the tool set: its
 * single reader spliced the names into a prompt as prose. `capability_grants`
 * replaces all three; `domain/capability-grants.ts` has the argument.
 */
export interface ArchetypeConfig {
  // Q&A
  citeSources?: boolean;
  // Task router
  inboundChannels?: string[];
  routingRules?: ArchetypeRoutingRule[];
  defaultAssignee?: ArchetypeAssignee;
  escalationTimeoutMinutes?: number;
  // Status update
  reportTemplate?: string;
  reportFormat?: string;
  deliveryChannels?: string[];
  schedule?: ArchetypeSchedule;
  compareWithPrevious?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function readAssignee(value: unknown): ArchetypeAssignee | undefined {
  const record = asRecord(value);
  if (record === null) return undefined;
  return {
    ...(typeof record.type === 'string' && { type: record.type }),
    ...(typeof record.id === 'string' && { id: record.id }),
    ...(typeof record.name === 'string' && { name: record.name }),
  };
}

function readSchedule(value: unknown): ArchetypeSchedule | undefined {
  const record = asRecord(value);
  if (record === null) return undefined;
  return {
    ...(typeof record.type === 'string' && { type: record.type }),
    ...(typeof record.time === 'string' && { time: record.time }),
    ...(stringArray(record.days) !== undefined && { days: stringArray(record.days) }),
    ...(typeof record.intervalMinutes === 'number' && {
      intervalMinutes: record.intervalMinutes,
    }),
    ...(typeof record.cron === 'string' && { cron: record.cron }),
  };
}

/**
 * The stored value, reduced to the members that are the type they claim to be.
 *
 * Returns an EMPTY config rather than null for a value that is not an object,
 * because every caller's next move is to read optional members off it — the
 * source spelled that `agent.archetypeConfig || {}`, and the two answers are the
 * same for a reader and different only for somebody testing presence.
 */
export function readArchetypeConfig(value: unknown): ArchetypeConfig {
  const record = asRecord(value);
  if (record === null) return {};
  return {
    ...(typeof record.citeSources === 'boolean' && { citeSources: record.citeSources }),
    ...(stringArray(record.inboundChannels) !== undefined && {
      inboundChannels: stringArray(record.inboundChannels),
    }),
    ...(Array.isArray(record.routingRules) && {
      routingRules: record.routingRules.flatMap((rule): ArchetypeRoutingRule[] => {
        const ruleRecord = asRecord(rule);
        if (ruleRecord === null) return [];
        return [
          {
            ...(typeof ruleRecord.condition === 'string' && { condition: ruleRecord.condition }),
            ...(typeof ruleRecord.priority === 'string' && { priority: ruleRecord.priority }),
            ...(readAssignee(ruleRecord.assignTo) !== undefined && {
              assignTo: readAssignee(ruleRecord.assignTo),
            }),
          },
        ];
      }),
    }),
    ...(readAssignee(record.defaultAssignee) !== undefined && {
      defaultAssignee: readAssignee(record.defaultAssignee),
    }),
    ...(typeof record.escalationTimeoutMinutes === 'number' && {
      escalationTimeoutMinutes: record.escalationTimeoutMinutes,
    }),
    ...(typeof record.reportTemplate === 'string' && { reportTemplate: record.reportTemplate }),
    ...(typeof record.reportFormat === 'string' && { reportFormat: record.reportFormat }),
    ...(stringArray(record.deliveryChannels) !== undefined && {
      deliveryChannels: stringArray(record.deliveryChannels),
    }),
    ...(readSchedule(record.schedule) !== undefined && {
      schedule: readSchedule(record.schedule),
    }),
    ...(typeof record.compareWithPrevious === 'boolean' && {
      compareWithPrevious: record.compareWithPrevious,
    }),
  };
}
