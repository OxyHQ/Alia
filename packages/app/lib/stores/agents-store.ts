import { create } from 'zustand';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';
import { errorMessage as getErrorMessage, errorStatus, errorResponseData } from '../errors/error-utils';

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
 * There is no avatar. An agent's likeness is `components/ui/agent-glyph.tsx`
 * drawn in `color` — so an agent with no color resolved is drawn in the theme's
 * own, which is the same fallback an unresolved name takes.
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
  skills: Array<{ _id: string; skillId: string; title: string; icon: string; color: string }>;
  knowledge: Array<{ _id: string; name: string; type: string; category: string; url: string }>;
  isFeatured: boolean;
  isTrending: boolean;
  isPublished: boolean;
  status: 'active' | 'idle' | 'offline';
  allowHiring: boolean;
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
      | 'allowHiring'
      | 'handlesAutonomousEvents'
      | 'systemPrompt'
      | 'archetype'
      | 'archetypeConfig'
    >
  > & { skills?: string[]; knowledge?: string[] };

interface AgentsStoreState {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  total: number;
  loadAgents: (params?: { category?: string; search?: string; featured?: string; trending?: string }) => Promise<void>;
  getAgent: (id: string) => Promise<Agent | null>;
  createAgent: (data: AgentCreate) => Promise<Agent | null>;
  updateAgent: (id: string, updates: AgentUpdate) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  hireAgent: (id: string, task: string) => Promise<string | null>;
}

export const useAgentsStore = create<AgentsStoreState>((set, get) => ({
  agents: [],
  loading: false,
  error: null,
  total: 0,

  loadAgents: async (params) => {
    try {
      set({ loading: true, error: null });
      const res = await apiClient.get<{ agents: Agent[]; total: number }>(API_ROUTES.agents.list, { params });
      set({ agents: res.data.agents, total: res.data.total, loading: false });
    } catch (error: unknown) {
      console.error('Error loading agents:', error);
      set({ error: getErrorMessage(error), loading: false });
    }
  },

  getAgent: async (id: string) => {
    try {
      const res = await apiClient.get<{ agent: Agent }>(API_ROUTES.agents.get(id));
      return res.data.agent;
    } catch (error) {
      console.error('Error getting agent:', error);
      return null;
    }
  },

  createAgent: async (data) => {
    try {
      const res = await apiClient.post<{ agent: Agent }>(API_ROUTES.agents.create, data);
      const agent = res.data.agent;
      set((state) => ({ agents: [agent, ...state.agents] }));
      return agent;
    } catch (error) {
      console.error('Error creating agent:', error);
      return null;
    }
  },

  /**
   * RETHROWS. A refused save has to reach the screen.
   *
   * This used to `console.error` and return, so a caller `await`ing it could
   * not tell a saved agent from a rejected one — and the agent editor, which
   * wrapped its call in `} catch { // silent }`, cleared its spinner and looked
   * saved. Every autosave the editor sent was in fact a 400, on every
   * keystroke, for as long as the screen existed. Two swallows in a row is what
   * kept that invisible.
   */
  updateAgent: async (id, updates) => {
    const res = await apiClient.patch<{ agent: Agent }>(API_ROUTES.agents.update(id), updates);
    const updated = res.data.agent;
    set((state) => ({
      agents: state.agents.map((a) => (a._id === id ? updated : a)),
    }));
  },

  deleteAgent: async (id) => {
    try {
      await apiClient.delete(API_ROUTES.agents.delete(id));
      set((state) => ({
        agents: state.agents.filter((a) => a._id !== id),
      }));
    } catch (error) {
      console.error('Error deleting agent:', error);
    }
  },

  hireAgent: async (id, task) => {
    try {
      const res = await apiClient.post<{ sessionId?: string }>(API_ROUTES.agents.hire(id), { task });
      return res.data.sessionId || null;
    } catch (error: unknown) {
      const status = errorStatus(error);
      const data = errorResponseData(error);
      if (status === 402) {
        throw new Error(`Insufficient credits. You need ${data?.creditsNeeded || 'more'} credits to hire this agent.`);
      }
      if (status === 503) {
        throw new Error('Agent execution infrastructure is currently unavailable. Please try again later.');
      }
      console.error('Error hiring agent:', error);
      // Through the extractor: an `/v1` body is an object, and `new Error`
      // stringifies it to `[object Object]` — a message that tells nobody
      // anything, in the one place somebody would look.
      throw new Error(getErrorMessage(error, 'Failed to hire agent'));
    }
  },
}));
