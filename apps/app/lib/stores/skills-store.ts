import { create } from 'zustand';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';

export interface Skill {
  _id: string;
  skillId: string;
  title: string;
  tagline: string;
  description: string;
  author: string;
  icon: string;
  color: string;
  category: 'featured' | 'community' | 'recent';
  language: string;
  triggers: string[];
  includes: string[];
  useCase: string;
  goodAt: string[];
  notGoodAt: string[];
  isBuiltIn: boolean;
  oxyUserId?: string;
  createdAt: string;
  updatedAt: string;
}

interface SkillsStoreState {
  skills: Skill[];
  mySkills: Skill[];
  loading: boolean;
  error: string | null;

  loadSkills: (params?: { language?: string; category?: string }) => Promise<void>;
  loadMySkills: () => Promise<void>;
  getSkill: (skillId: string) => Promise<Skill | null>;
  createSkill: (data: Partial<Skill> & { systemPrompt: string }) => Promise<Skill | null>;
  updateSkill: (skillId: string, updates: Partial<Skill>) => Promise<void>;
  deleteSkill: (skillId: string) => Promise<void>;
}

export const useSkillsStore = create<SkillsStoreState>((set) => ({
  skills: [],
  mySkills: [],
  loading: false,
  error: null,

  loadSkills: async (params) => {
    try {
      set({ loading: true, error: null });
      const res = await apiClient.get(API_ROUTES.skills.list, { params });
      set({ skills: res.data.skills, loading: false });
    } catch (error: any) {
      console.error('Error loading skills:', error);
      set({ error: error.message, loading: false });
    }
  },

  loadMySkills: async () => {
    try {
      const res = await apiClient.get(API_ROUTES.skills.me);
      set({ mySkills: res.data.skills });
    } catch (error: any) {
      console.error('Error loading my skills:', error);
    }
  },

  getSkill: async (skillId: string) => {
    try {
      const res = await apiClient.get(API_ROUTES.skills.get(skillId));
      return res.data.skill;
    } catch (error) {
      console.error('Error getting skill:', error);
      return null;
    }
  },

  createSkill: async (data) => {
    try {
      const res = await apiClient.post(API_ROUTES.skills.create, data);
      const skill = res.data.skill;
      set((state) => ({
        skills: [skill, ...state.skills],
        mySkills: [skill, ...state.mySkills],
      }));
      return skill;
    } catch (error) {
      console.error('Error creating skill:', error);
      return null;
    }
  },

  updateSkill: async (skillId, updates) => {
    try {
      const res = await apiClient.patch(API_ROUTES.skills.update(skillId), updates);
      const updated = res.data.skill;
      set((state) => ({
        skills: state.skills.map((s) => (s.skillId === skillId ? updated : s)),
        mySkills: state.mySkills.map((s) => (s.skillId === skillId ? updated : s)),
      }));
    } catch (error) {
      console.error('Error updating skill:', error);
    }
  },

  deleteSkill: async (skillId) => {
    try {
      await apiClient.delete(API_ROUTES.skills.delete(skillId));
      set((state) => ({
        skills: state.skills.filter((s) => s.skillId !== skillId),
        mySkills: state.mySkills.filter((s) => s.skillId !== skillId),
      }));
    } catch (error) {
      console.error('Error deleting skill:', error);
    }
  },
}));
