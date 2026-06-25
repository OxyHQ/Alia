import { create } from 'zustand';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';
import { errorMessage as getErrorMessage, errorStatus, errorResponseData } from '../errors/error-utils';

export interface AgentAccessory {
  accessoryId: string;
  position: { x: number; y: number; scale: number; rotation: number };
}

/** Normalizes accessories from API (may be string[] or AgentAccessory[]) */
export function normalizeAccessories(raw: unknown): AgentAccessory[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === 'string') {
      return { accessoryId: item, position: { x: 0.5, y: 0.5, scale: 1, rotation: 0 } };
    }
    if (item && typeof item === 'object' && 'accessoryId' in item) {
      return item as AgentAccessory;
    }
    return null;
  }).filter(Boolean) as AgentAccessory[];
}

export interface Agent {
  _id: string;
  name: string;
  handle: string;
  avatar: string | null;
  tagline: string;
  description: string;
  author: string;
  authorName: string;
  authorVerified: boolean;
  category: string;
  tags: string[];
  rating: number;
  reviewCount: number;
  usageCount: number;
  hireCount: number;
  price: number | null;
  capabilities: string[];
  skills: Array<{ _id: string; skillId: string; title: string; icon: string; color: string }>;
  knowledge: Array<{ _id: string; name: string; type: string; category: string; url: string }>;
  isVerified: boolean;
  isFeatured: boolean;
  isTrending: boolean;
  isPublished: boolean;
  status: 'active' | 'idle' | 'offline';
  creditBalance: number;
  accessories: AgentAccessory[];
  allowHiring: boolean;
  systemPrompt?: string;
  allowedModels?: string[];
  archetype?: 'general' | 'qa' | 'task_router' | 'status_update';
  archetypeConfig?: {
    // Q&A
    knowledgeSources?: { integrations?: string[]; mcpServers?: string[]; oxyServices?: string[] };
    citeSources?: boolean;
    // Task Router
    inboundChannels?: string[];
    routingRules?: Array<{ condition: string; priority: 'low' | 'medium' | 'high' | 'urgent'; assignTo: { type: 'agent' | 'team' | 'user'; id: string; name?: string } }>;
    defaultAssignee?: { type: 'agent' | 'team' | 'user'; id: string; name?: string };
    escalationTimeoutMinutes?: number;
    // Status Update
    dataSources?: { integrations?: string[]; mcpServers?: string[]; oxyServices?: string[] };
    reportTemplate?: string;
    reportFormat?: 'markdown' | 'html' | 'plain';
    deliveryChannels?: string[];
    schedule?: { type: 'daily' | 'interval' | 'cron'; time?: string; days?: string[]; intervalMinutes?: number; cron?: string };
    compareWithPrevious?: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

interface AgentsStoreState {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  total: number;
  loadAgents: (params?: { category?: string; search?: string; featured?: string; trending?: string }) => Promise<void>;
  getAgent: (id: string) => Promise<Agent | null>;
  createAgent: (data: Partial<Agent>) => Promise<Agent | null>;
  updateAgent: (id: string, updates: Partial<Agent>) => Promise<void>;
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
      const res = await apiClient.get(API_ROUTES.agents.list, { params });
      const agents = (res.data.agents as Agent[]).map((a) => ({
        ...a,
        accessories: normalizeAccessories(a.accessories),
      }));
      set({ agents, total: res.data.total, loading: false });
    } catch (error: unknown) {
      console.error('Error loading agents:', error);
      set({ error: getErrorMessage(error), loading: false });
    }
  },

  getAgent: async (id: string) => {
    try {
      const res = await apiClient.get(API_ROUTES.agents.get(id));
      const agent = res.data.agent;
      return { ...agent, accessories: normalizeAccessories(agent.accessories) } as Agent;
    } catch (error) {
      console.error('Error getting agent:', error);
      return null;
    }
  },

  createAgent: async (data) => {
    try {
      const res = await apiClient.post(API_ROUTES.agents.create, data);
      const agent = res.data.agent;
      set((state) => ({ agents: [agent, ...state.agents] }));
      return agent;
    } catch (error) {
      console.error('Error creating agent:', error);
      return null;
    }
  },

  updateAgent: async (id, updates) => {
    try {
      const res = await apiClient.patch(API_ROUTES.agents.update(id), updates);
      const updated = res.data.agent;
      set((state) => ({
        agents: state.agents.map((a) => (a._id === id ? updated : a)),
      }));
    } catch (error) {
      console.error('Error updating agent:', error);
    }
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
      const res = await apiClient.post(API_ROUTES.agents.hire(id), { task });
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
      throw new Error(data?.error || 'Failed to hire agent');
    }
  },
}));
