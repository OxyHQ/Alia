/**
 * The agent shapes the API serves and accepts.
 *
 * These lived in `lib/stores/agents-store.ts` while that store WAS the agent
 * data layer. It is gone — every agent read and write is a TanStack query or
 * mutation now — so the types moved here rather than being copied to each hook
 * that needs them. `lib/hooks/use-agents.ts` and `lib/hooks/use-my-agents.ts`
 * are the two places that fetch them.
 */

export type AgentArchetype = 'general' | 'qa' | 'task_router' | 'status_update';

export interface RoutingRule {
  condition: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignTo: { type: 'agent' | 'team' | 'user'; id: string; name?: string };
}

export interface ArchetypeConfig {
  // Q&A
  citeSources?: boolean;
  // Task Router
  inboundChannels?: string[];
  routingRules?: RoutingRule[];
  defaultAssignee?: { type: 'agent' | 'team' | 'user'; id: string; name?: string };
  escalationTimeoutMinutes?: number;
  // Status Update
  reportTemplate?: string;
  reportFormat?: 'markdown' | 'html' | 'plain';
  deliveryChannels?: string[];
  schedule?: { type: 'daily' | 'interval' | 'cron'; time?: string; days?: string[]; intervalMinutes?: number; cron?: string };
  compareWithPrevious?: boolean;
}

/**
 * An agent, as the API serves it.
 *
 * An agent IS an Oxy `bot` account: `oxyAccountId` is the seam, and `name`,
 * `handle` and `color` are READ from that account rather than stored by Alia.
 * They are nullable because the API resolves them through a batched Oxy lookup
 * that FAILS OPEN — an account it cannot resolve leaves the three null and the
 * listing still renders, because the tagline, the rating and the price are
 * Alia's own.
 *
 * They are also READ-ONLY. `AgentUpdate` cannot carry them and `PATCH /agents`
 * refuses them outright: editing an agent's name is `updateAccount` at Oxy.
 *
 * There is no avatar. An agent's likeness is the same `IdentityMark` Alia
 * wears, drawn in `color` — so an agent with no color resolved is drawn in the
 * theme's own, which is the same fallback an unresolved name takes.
 */
export interface Agent {
  _id: string;
  /** The Oxy `bot` account this agent IS. */
  oxyAccountId: string;
  name: string | null;
  handle: string | null;
  color: string | null;
  tagline: string;
  description: string;
  /** The Oxy account that created the agent. An id, never a name. */
  author: string;
  /** The author's display name, resolved by the API from Oxy. */
  authorName: string | null;
  category: string;
  tags: string[];
  rating: number;
  reviewCount: number;
  usageCount: number;
  hireCount: number;
  price: number | null;
  /**
   * What this agent may reach: `family` or `family:instanceId` strings.
   *
   * EMPTY DENIES EVERYTHING, which is the reverse of the three vocabularies it
   * replaced — `capabilities`, `permissions` and
   * `archetypeConfig.knowledgeSources`, where an unset value meant *allowed*.
   * The labels live in `lib/constants/capability-families.ts`; the vocabulary
   * itself is the API's.
   */
  capabilityGrants: string[];
  skills: Array<{ _id: string; name: string; displayName: string; icon: string | null; color: string | null }>;
  /**
   * The newest line of THIS person's thread with the agent, and when it landed.
   *
   * Served by `GET /agents/me` only, and `null` on an agent nobody has spoken to
   * yet — which is the ordinary case the moment one is created. Absent entirely
   * on the catalogue's agents, which is a different list about other people's
   * agents and has no thread to speak of.
   */
  lastMessage?: string | null;
  lastMessageAt?: string | null;
  knowledge: Array<{ _id: string; name: string; type: string; category: string; url: string }>;
  isFeatured: boolean;
  isTrending: boolean;
  isPublished: boolean;
  status: 'active' | 'idle' | 'offline';
  /**
   * Who may USE this agent, as opposed to who may FIND it — `isPublished`
   * answers the second. `private` is its owner plus whoever holds a membership
   * on its bot account, which is how an agent is shared; `public` is anyone.
   */
  access: 'private' | 'public';
  /**
   * Whether this is the ONE agent the owner has designated to run autonomous
   * Oxy service events. A declared fact: the API enforces one per owner with a
   * partial unique index and answers 409 for a second, so a screen offering the
   * toggle has to handle that refusal rather than assume it can always set it.
   */
  handlesAutonomousEvents: boolean;
  systemPrompt?: string;
  allowedModels?: string[];
  archetype?: AgentArchetype;
  archetypeConfig?: ArchetypeConfig;
  createdAt: string;
  updatedAt: string;
}

/**
 * Write payload for agent updates. Unlike the read {@link Agent} model, `skills`
 * and `knowledge` are sent as bare id arrays — the API resolves them to full
 * objects on the way back.
 *
 * The identity fields are OMITTED, not optional. `PATCH /agents/:id` validates
 * with a strict schema and answers 400 for any of them, so a screen that could
 * still put `name` in this object would compile and fail at runtime — the exact
 * shape a type is for.
 */
export type AgentUpdate = Partial<
  Omit<Agent, 'skills' | 'knowledge' | 'name' | 'handle' | 'avatar' | 'oxyAccountId' | '_id'>
> & {
  skills?: string[];
  knowledge?: string[];
};

/**
 * What `POST /agents` accepts: the runtime, plus the account the agent IS.
 *
 * `oxyAccountId` is REQUIRED and the caller mints it first — `useOxy()
 * .createAccount({ kind: 'bot', … })` — because Oxy owns the account and only
 * the person's own credential may create one under their tree.
 */
export type AgentCreate = Pick<Agent, 'oxyAccountId' | 'tagline' | 'description' | 'category'> &
  Partial<
    Pick<
      Agent,
      | 'tags'
      | 'price'
      | 'capabilityGrants'
      | 'isPublished'
      | 'access'
      | 'handlesAutonomousEvents'
      | 'systemPrompt'
      | 'archetype'
      | 'archetypeConfig'
    >
  > & { skills?: string[]; knowledge?: string[] };
