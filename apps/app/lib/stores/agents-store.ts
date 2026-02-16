import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface Agent {
  id: string;
  name: string;
  handle: string;
  avatar: string | null;
  banner: string | null;
  bannerGradient: string[];
  tagline: string;
  description: string;
  author: string;
  authorVerified: boolean;
  category: string;
  tags: string[];
  rating: number;
  reviewCount: number;
  usageCount: number;
  followerCount: number;
  hireCount: number;
  price: number | null;
  capabilities: string[];
  isVerified: boolean;
  isFeatured: boolean;
  isTrending: boolean;
  isPublished: boolean;
  status: "active" | "idle" | "offline";
  isCustom: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface AgentsStoreState {
  agents: Agent[];
  loadAgents: () => Promise<void>;
  createAgent: (
    agent: Omit<
      Agent,
      "id" | "createdAt" | "updatedAt" | "usageCount" | "followerCount" | "hireCount"
    >
  ) => Promise<void>;
  updateAgent: (id: string, updates: Partial<Agent>) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  incrementUsage: (id: string) => Promise<void>;
  toggleFollow: (id: string) => Promise<void>;
  getDefaultAgents: () => Agent[];
}

const AGENTS_STORAGE_KEY = "alia-agents";
const AGENTS_SCHEMA_VERSION = "1.0";
const AGENTS_VERSION_KEY = "alia-agents-version";

const DEFAULT_AGENTS: Omit<Agent, "id" | "createdAt" | "updatedAt">[] = [
  {
    name: "Code Assistant",
    handle: "@codeassist",
    avatar: null,
    banner: null,
    bannerGradient: ["#6366f1", "#8b5cf6"],
    tagline: "Full-stack engineer that writes, reviews, and deploys code 24/7",
    description:
      "An autonomous coding agent that can build features, fix bugs, write tests, and handle code reviews. Works across multiple languages and frameworks with deep knowledge of best practices.",
    author: "Alia Team",
    authorVerified: true,
    category: "Development",
    tags: ["coding", "debugging", "testing", "devops"],
    rating: 4.9,
    reviewCount: 1243,
    usageCount: 18400,
    followerCount: 5230,
    hireCount: 3120,
    price: null,
    capabilities: [
      "Web Browsing",
      "Code Execution",
      "File Management",
      "Git Operations",
      "API Integration",
    ],
    isVerified: true,
    isFeatured: true,
    isTrending: true,
    isPublished: true,
    status: "active",
    isCustom: false,
  },
  {
    name: "Research Analyst",
    handle: "@researcher",
    avatar: null,
    banner: null,
    bannerGradient: ["#0ea5e9", "#06b6d4"],
    tagline: "Deep research with citations and structured analysis",
    description:
      "Conducts thorough research across the web, synthesizes findings into structured reports with proper citations. Perfect for market research, competitive analysis, and academic exploration.",
    author: "Alia Team",
    authorVerified: true,
    category: "Research",
    tags: ["research", "analysis", "reports", "citations"],
    rating: 4.8,
    reviewCount: 876,
    usageCount: 12300,
    followerCount: 3890,
    hireCount: 2450,
    price: null,
    capabilities: [
      "Web Browsing",
      "Document Analysis",
      "Data Extraction",
      "Report Generation",
    ],
    isVerified: true,
    isFeatured: true,
    isTrending: false,
    isPublished: true,
    status: "active",
    isCustom: false,
  },
  {
    name: "Marketing Strategist",
    handle: "@marketer",
    avatar: null,
    banner: null,
    bannerGradient: ["#f43f5e", "#ec4899"],
    tagline: "Growth strategies, content plans, and campaign execution",
    description:
      "Creates comprehensive marketing strategies, content calendars, and campaign plans. Analyzes market trends and competitor activity to drive growth and engagement.",
    author: "Alia Team",
    authorVerified: true,
    category: "Marketing",
    tags: ["marketing", "growth", "content", "social media"],
    rating: 4.7,
    reviewCount: 534,
    usageCount: 8900,
    followerCount: 2670,
    hireCount: 1890,
    price: 0.5,
    capabilities: [
      "Web Browsing",
      "Content Generation",
      "Analytics",
      "Social Media",
      "Email Campaigns",
    ],
    isVerified: true,
    isFeatured: true,
    isTrending: true,
    isPublished: true,
    status: "active",
    isCustom: false,
  },
  {
    name: "Data Scientist",
    handle: "@datasci",
    avatar: null,
    banner: null,
    bannerGradient: ["#10b981", "#059669"],
    tagline: "Turn raw data into actionable insights and visualizations",
    description:
      "Processes, analyzes, and visualizes data to uncover patterns and trends. Builds predictive models and generates comprehensive data reports with clear recommendations.",
    author: "Alia Team",
    authorVerified: true,
    category: "Data",
    tags: ["data", "analytics", "visualization", "machine learning"],
    rating: 4.8,
    reviewCount: 423,
    usageCount: 6700,
    followerCount: 1980,
    hireCount: 1340,
    price: 1.0,
    capabilities: [
      "Code Execution",
      "Data Processing",
      "Visualization",
      "Statistical Analysis",
      "ML Models",
    ],
    isVerified: true,
    isFeatured: false,
    isTrending: true,
    isPublished: true,
    status: "idle",
    isCustom: false,
  },
  {
    name: "Creative Director",
    handle: "@creative",
    avatar: null,
    banner: null,
    bannerGradient: ["#f59e0b", "#d97706"],
    tagline: "Brand identity, design briefs, and creative campaigns",
    description:
      "Develops brand strategies, creative concepts, and design briefs. Helps shape visual identity and messaging across all touchpoints with a focus on consistency and impact.",
    author: "Alia Team",
    authorVerified: true,
    category: "Creative",
    tags: ["design", "branding", "creative", "copywriting"],
    rating: 4.6,
    reviewCount: 312,
    usageCount: 5400,
    followerCount: 1540,
    hireCount: 980,
    price: 0.75,
    capabilities: [
      "Content Generation",
      "Image Analysis",
      "Brand Strategy",
      "Copywriting",
    ],
    isVerified: true,
    isFeatured: false,
    isTrending: false,
    isPublished: true,
    status: "active",
    isCustom: false,
  },
  {
    name: "Customer Support Pro",
    handle: "@supportpro",
    avatar: null,
    banner: null,
    bannerGradient: ["#8b5cf6", "#a855f7"],
    tagline: "24/7 customer support that handles tickets and escalations",
    description:
      "Manages customer inquiries, resolves common issues, and escalates complex cases. Maintains a friendly, professional tone and keeps detailed records of all interactions.",
    author: "Alia Team",
    authorVerified: true,
    category: "Support",
    tags: ["support", "customer service", "tickets", "helpdesk"],
    rating: 4.7,
    reviewCount: 689,
    usageCount: 14200,
    followerCount: 3210,
    hireCount: 2780,
    price: null,
    capabilities: [
      "Messaging",
      "Ticket Management",
      "Knowledge Base",
      "Notifications",
      "Escalation",
    ],
    isVerified: true,
    isFeatured: false,
    isTrending: false,
    isPublished: true,
    status: "active",
    isCustom: false,
  },
  {
    name: "Legal Advisor",
    handle: "@legalai",
    avatar: null,
    banner: null,
    bannerGradient: ["#64748b", "#475569"],
    tagline: "Contract review, compliance checks, and legal research",
    description:
      "Reviews contracts, identifies potential issues, and provides legal research summaries. Helps with compliance documentation and policy drafting. Not a substitute for professional legal advice.",
    author: "LegalTech Labs",
    authorVerified: false,
    category: "Legal",
    tags: ["legal", "contracts", "compliance", "policy"],
    rating: 4.5,
    reviewCount: 198,
    usageCount: 3200,
    followerCount: 870,
    hireCount: 620,
    price: 2.0,
    capabilities: [
      "Document Analysis",
      "Web Browsing",
      "Report Generation",
      "Compliance Checks",
    ],
    isVerified: false,
    isFeatured: false,
    isTrending: false,
    isPublished: true,
    status: "offline",
    isCustom: false,
  },
  {
    name: "DevOps Engineer",
    handle: "@devopsbot",
    avatar: null,
    banner: null,
    bannerGradient: ["#ea580c", "#dc2626"],
    tagline: "Infrastructure automation, CI/CD pipelines, and monitoring",
    description:
      "Sets up and maintains CI/CD pipelines, manages cloud infrastructure, and monitors system health. Automates deployment workflows and handles incident response with detailed runbooks.",
    author: "CloudOps Inc",
    authorVerified: true,
    category: "Development",
    tags: ["devops", "infrastructure", "ci/cd", "monitoring"],
    rating: 4.8,
    reviewCount: 356,
    usageCount: 7800,
    followerCount: 2140,
    hireCount: 1560,
    price: 1.5,
    capabilities: [
      "Code Execution",
      "VM Access",
      "Cloud APIs",
      "Monitoring",
      "Notifications",
    ],
    isVerified: true,
    isFeatured: false,
    isTrending: true,
    isPublished: true,
    status: "idle",
    isCustom: false,
  },
];

export const useAgentsStore = create<AgentsStoreState>((set, get) => ({
  agents: [],

  loadAgents: async () => {
    try {
      const [agentsData, storedVersion] = await Promise.all([
        AsyncStorage.getItem(AGENTS_STORAGE_KEY),
        AsyncStorage.getItem(AGENTS_VERSION_KEY),
      ]);

      let agents: Agent[] = [];
      const needsReset = !storedVersion || storedVersion !== AGENTS_SCHEMA_VERSION;

      if (agentsData && !needsReset) {
        try {
          const parsed = JSON.parse(agentsData);
          agents = parsed.map((agent: any) => ({
            ...agent,
            createdAt: new Date(agent.createdAt),
            updatedAt: new Date(agent.updatedAt),
          }));
        } catch (parseError) {
          console.error("Error parsing agents data:", parseError);
        }
      }

      if (agents.length === 0 || needsReset) {
        agents = DEFAULT_AGENTS.map((agent, index) => ({
          ...agent,
          id: `agent-default-${index}`,
          createdAt: new Date(),
          updatedAt: new Date(),
        }));
        await AsyncStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(agents));
        await AsyncStorage.setItem(AGENTS_VERSION_KEY, AGENTS_SCHEMA_VERSION);
      }

      set({ agents });
    } catch (error) {
      console.error("Error loading agents:", error);
    }
  },

  createAgent: async (agentData) => {
    try {
      const state = get();
      const agent: Agent = {
        ...agentData,
        id: `agent-${Date.now()}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        usageCount: 0,
        followerCount: 0,
        hireCount: 0,
      };

      const newAgents = [...state.agents, agent];
      await Promise.all([
        AsyncStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(newAgents)),
        AsyncStorage.setItem(AGENTS_VERSION_KEY, AGENTS_SCHEMA_VERSION),
      ]);
      set({ agents: newAgents });
    } catch (error) {
      console.error("Error creating agent:", error);
    }
  },

  updateAgent: async (id: string, updates: Partial<Agent>) => {
    try {
      const state = get();
      const newAgents = state.agents.map((agent) =>
        agent.id === id
          ? { ...agent, ...updates, updatedAt: new Date() }
          : agent
      );
      await Promise.all([
        AsyncStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(newAgents)),
        AsyncStorage.setItem(AGENTS_VERSION_KEY, AGENTS_SCHEMA_VERSION),
      ]);
      set({ agents: newAgents });
    } catch (error) {
      console.error("Error updating agent:", error);
    }
  },

  deleteAgent: async (id: string) => {
    try {
      const state = get();
      const agent = state.agents.find((a) => a.id === id);
      if (agent && !agent.isCustom) {
        console.warn("Cannot delete default agents");
        return;
      }

      const newAgents = state.agents.filter((agent) => agent.id !== id);
      await AsyncStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(newAgents));
      set({ agents: newAgents });
    } catch (error) {
      console.error("Error deleting agent:", error);
    }
  },

  incrementUsage: async (id: string) => {
    try {
      const state = get();
      const newAgents = state.agents.map((agent) =>
        agent.id === id
          ? { ...agent, usageCount: agent.usageCount + 1, updatedAt: new Date() }
          : agent
      );
      await Promise.all([
        AsyncStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(newAgents)),
        AsyncStorage.setItem(AGENTS_VERSION_KEY, AGENTS_SCHEMA_VERSION),
      ]);
      set({ agents: newAgents });
    } catch (error) {
      console.error("Error incrementing usage:", error);
    }
  },

  toggleFollow: async (id: string) => {
    try {
      const state = get();
      const agent = state.agents.find((a) => a.id === id);
      if (!agent) return;

      const newAgents = state.agents.map((a) =>
        a.id === id
          ? {
              ...a,
              followerCount: a.followerCount + 1,
              updatedAt: new Date(),
            }
          : a
      );
      await Promise.all([
        AsyncStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(newAgents)),
        AsyncStorage.setItem(AGENTS_VERSION_KEY, AGENTS_SCHEMA_VERSION),
      ]);
      set({ agents: newAgents });
    } catch (error) {
      console.error("Error toggling follow:", error);
    }
  },

  getDefaultAgents: () => {
    return get().agents.filter((agent) => !agent.isCustom);
  },
}));
