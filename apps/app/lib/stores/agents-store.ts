import { create } from 'zustand';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';

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
  isVerified: boolean;
  isFeatured: boolean;
  isTrending: boolean;
  isPublished: boolean;
  status: 'active' | 'idle' | 'offline';
  creditBalance: number;
  allowHiring: boolean;
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
      set({
        agents: res.data.agents,
        total: res.data.total,
        loading: false,
      });
    } catch (error: any) {
      console.error('Error loading agents:', error);
      set({ error: error.message, loading: false });
    }
  },

  getAgent: async (id: string) => {
    try {
      const res = await apiClient.get(API_ROUTES.agents.get(id));
      return res.data.agent;
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
    } catch (error) {
      console.error('Error hiring agent:', error);
      return null;
    }
  },
}));
