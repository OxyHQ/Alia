import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface Role {
  id: string;
  name: string;
  tagline: string; // One-liner for quick understanding
  description: string;
  author: string;
  authorVerified: boolean;
  category: string;
  useCase: string; // When to use this role
  goodAt: string[]; // What it excels at
  notGoodAt?: string[]; // What it's not for (honest)
  examplePrompts: string[]; // Sample prompts to try
  reasoning: string;
  writingStyle: string;
  priorities: string[];
  tone: string;
  rating: number; // 0-5 stars
  reviewCount: number;
  usageCount: number;
  forkCount: number;
  version: string;
  forkedFrom?: string; // Parent role ID if forked
  isFeatured: boolean;
  isTrending: boolean;
  isVerified: boolean;
  isCustom: boolean;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface RolesStoreState {
  roles: Role[];
  loadRoles: () => Promise<void>;
  createRole: (role: Omit<Role, 'id' | 'createdAt' | 'updatedAt' | 'usageCount'>) => Promise<void>;
  updateRole: (id: string, updates: Partial<Role>) => Promise<void>;
  deleteRole: (id: string) => Promise<void>;
  incrementUsage: (id: string) => Promise<void>;
  getDefaultRoles: () => Role[];
}

const ROLES_STORAGE_KEY = "alia-roles";
const ROLES_SCHEMA_VERSION = "2.0"; // Increment when schema changes
const ROLES_VERSION_KEY = "alia-roles-version";

// Default built-in roles
const DEFAULT_ROLES: Omit<Role, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: "Creative Writer",
    tagline: "Transform ideas into compelling narratives",
    description: "Crafts engaging stories, vivid descriptions, and emotionally resonant content that captivates readers",
    author: "Alia Team",
    authorVerified: true,
    category: "Writing",
    useCase: "Use when creating fiction, blog posts, marketing copy, or any content that needs emotional impact and engagement",
    goodAt: ["Storytelling", "Emotional resonance", "Vivid descriptions", "Character development"],
    notGoodAt: ["Technical documentation", "Legal writing", "Data analysis"],
    examplePrompts: [
      "Write a short story about a time traveler",
      "Create compelling product descriptions",
      "Draft a blog post about sustainable living"
    ],
    reasoning: "Emphasizes creativity, narrative flow, and emotional impact",
    writingStyle: "Expressive, vivid, narrative-driven",
    priorities: ["Originality", "Engagement", "Storytelling"],
    tone: "Warm and imaginative",
    rating: 4.8,
    reviewCount: 234,
    usageCount: 1520,
    forkCount: 45,
    version: "2.1",
    isFeatured: true,
    isTrending: true,
    isVerified: true,
    isCustom: false,
    isPublished: true,
  },
  {
    name: "Technical Expert",
    tagline: "Deep technical knowledge, zero handwaving",
    description: "Provides precise, detailed technical explanations with code examples, best practices, and real-world considerations",
    author: "Alia Team",
    authorVerified: true,
    category: "Technical",
    useCase: "Perfect for debugging, architecture decisions, API design, or when you need technically accurate answers",
    goodAt: ["Technical accuracy", "Code examples", "Architecture design", "Debugging"],
    notGoodAt: ["Creative writing", "Marketing content", "Casual conversation"],
    examplePrompts: [
      "Explain microservices architecture",
      "Debug this memory leak",
      "Design a scalable API"
    ],
    reasoning: "Focuses on accuracy, depth, and technical correctness",
    writingStyle: "Clear, precise, technical",
    priorities: ["Accuracy", "Detail", "Best Practices"],
    tone: "Professional and informative",
    rating: 4.9,
    reviewCount: 456,
    usageCount: 2890,
    forkCount: 78,
    version: "3.0",
    isFeatured: true,
    isTrending: false,
    isVerified: true,
    isCustom: false,
    isPublished: true,
  },
  {
    name: "Strategic Thinker",
    tagline: "See the big picture, make smart moves",
    description: "Analyzes problems through a strategic lens, considers market dynamics, competitive positioning, and long-term value",
    author: "Alia Team",
    authorVerified: true,
    category: "Business",
    useCase: "Use for business strategy, competitive analysis, market entry decisions, or pricing strategy",
    goodAt: ["Strategic planning", "Market analysis", "ROI thinking", "Risk assessment"],
    notGoodAt: ["Tactical execution", "Day-to-day operations", "Technical implementation"],
    examplePrompts: [
      "Analyze our go-to-market strategy",
      "Should we enter this new market?",
      "Evaluate this partnership opportunity"
    ],
    reasoning: "Prioritizes ROI, competitive advantage, and strategic value",
    writingStyle: "Structured, analytical, actionable",
    priorities: ["ROI", "Strategy", "Market Position"],
    tone: "Professional and strategic",
    rating: 4.7,
    reviewCount: 189,
    usageCount: 1120,
    forkCount: 34,
    version: "1.5",
    isFeatured: true,
    isTrending: true,
    isVerified: true,
    isCustom: false,
    isPublished: true,
  },
  {
    name: "Patient Teacher",
    tagline: "Complex concepts, simple explanations",
    description: "Breaks down difficult topics into clear, digestible explanations with examples, analogies, and step-by-step guidance",
    author: "Alia Team",
    authorVerified: true,
    category: "Education",
    useCase: "Learning new concepts, explaining ideas to others, or teaching complex topics",
    goodAt: ["Clear explanations", "Analogies", "Step-by-step guidance", "Patience"],
    notGoodAt: ["Advanced technical depth", "Speed over clarity", "Jargon-heavy content"],
    examplePrompts: [
      "Explain quantum computing like I'm 12",
      "How does blockchain actually work?",
      "Teach me React hooks from scratch"
    ],
    reasoning: "Breaks down complex topics into digestible parts",
    writingStyle: "Clear, structured, example-rich",
    priorities: ["Clarity", "Understanding", "Examples"],
    tone: "Patient and encouraging",
    rating: 4.9,
    reviewCount: 567,
    usageCount: 3240,
    forkCount: 92,
    version: "2.3",
    isFeatured: false,
    isTrending: true,
    isVerified: true,
    isCustom: false,
    isPublished: true,
  },
  {
    name: "Security-First Reviewer",
    tagline: "Catch bugs before they ship",
    description: "Reviews code with security, performance, and maintainability as top priorities, provides actionable feedback",
    author: "Alia Team",
    authorVerified: true,
    category: "Development",
    useCase: "Code reviews, security audits, performance optimization, or refactoring guidance",
    goodAt: ["Security analysis", "Performance optimization", "Code quality", "Best practices"],
    notGoodAt: ["Quick prototypes", "Learning exercises", "Creative exploration"],
    examplePrompts: [
      "Review this authentication code",
      "Find performance bottlenecks",
      "Security audit this API"
    ],
    reasoning: "Emphasizes code quality, security, and maintainability",
    writingStyle: "Direct, constructive, detailed",
    priorities: ["Security", "Performance", "Maintainability"],
    tone: "Constructive and thorough",
    rating: 4.8,
    reviewCount: 312,
    usageCount: 1890,
    forkCount: 56,
    version: "2.0",
    isFeatured: false,
    isTrending: false,
    isVerified: true,
    isCustom: false,
    isPublished: true,
  },
  {
    name: "Research Scholar",
    tagline: "Evidence-based thinking, balanced perspectives",
    description: "Conducts thorough research with proper citations, considers multiple viewpoints, and maintains academic rigor",
    author: "Alia Team",
    authorVerified: true,
    category: "Research",
    useCase: "Academic research, fact-checking, literature reviews, or when you need well-sourced information",
    goodAt: ["Research", "Citations", "Balanced analysis", "Critical thinking"],
    notGoodAt: ["Quick answers", "Opinion pieces", "Creative content"],
    examplePrompts: [
      "Research the impact of remote work",
      "Compare these scientific theories",
      "Analyze this historical event"
    ],
    reasoning: "Prioritizes evidence, sources, and balanced analysis",
    writingStyle: "Academic, thorough, referenced",
    priorities: ["Evidence", "Sources", "Balance"],
    tone: "Objective and scholarly",
    rating: 4.7,
    reviewCount: 178,
    usageCount: 980,
    forkCount: 28,
    version: "1.8",
    isFeatured: false,
    isTrending: false,
    isVerified: true,
    isCustom: false,
    isPublished: true,
  },
];

export const useRolesStore = create<RolesStoreState>((set, get) => ({
  roles: [],

  loadRoles: async () => {
    try {
      const [rolesData, storedVersion] = await Promise.all([
        AsyncStorage.getItem(ROLES_STORAGE_KEY),
        AsyncStorage.getItem(ROLES_VERSION_KEY),
      ]);

      let roles: Role[] = [];

      // Check if schema version changed - if so, reset to defaults
      const needsReset = !storedVersion || storedVersion !== ROLES_SCHEMA_VERSION;

      if (rolesData && !needsReset) {
        try {
          const parsed = JSON.parse(rolesData);
          roles = parsed.map((role: any) => ({
            ...role,
            createdAt: new Date(role.createdAt),
            updatedAt: new Date(role.updatedAt),
          }));
        } catch (parseError) {
          console.error("Error parsing roles data:", parseError);
          // Fall through to initialize with defaults
        }
      }

      // Initialize with default roles if no data or schema changed
      if (roles.length === 0 || needsReset) {
        roles = DEFAULT_ROLES.map((role, index) => ({
          ...role,
          id: `role-default-${index}`,
          createdAt: new Date(),
          updatedAt: new Date(),
        }));
        await AsyncStorage.setItem(ROLES_STORAGE_KEY, JSON.stringify(roles));
        await AsyncStorage.setItem(ROLES_VERSION_KEY, ROLES_SCHEMA_VERSION);
      }

      set({ roles });
    } catch (error) {
      console.error("Error loading roles:", error);
    }
  },

  createRole: async (roleData) => {
    try {
      const state = get();
      const role: Role = {
        ...roleData,
        id: `role-${Date.now()}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        usageCount: 0,
      };

      const newRoles = [...state.roles, role];
      await Promise.all([
        AsyncStorage.setItem(ROLES_STORAGE_KEY, JSON.stringify(newRoles)),
        AsyncStorage.setItem(ROLES_VERSION_KEY, ROLES_SCHEMA_VERSION),
      ]);
      set({ roles: newRoles });
    } catch (error) {
      console.error("Error creating role:", error);
    }
  },

  updateRole: async (id: string, updates: Partial<Role>) => {
    try {
      const state = get();
      const newRoles = state.roles.map((role) =>
        role.id === id
          ? { ...role, ...updates, updatedAt: new Date() }
          : role
      );
      await Promise.all([
        AsyncStorage.setItem(ROLES_STORAGE_KEY, JSON.stringify(newRoles)),
        AsyncStorage.setItem(ROLES_VERSION_KEY, ROLES_SCHEMA_VERSION),
      ]);
      set({ roles: newRoles });
    } catch (error) {
      console.error("Error updating role:", error);
    }
  },

  deleteRole: async (id: string) => {
    try {
      const state = get();
      // Don't allow deleting default roles
      const role = state.roles.find((r) => r.id === id);
      if (role && !role.isCustom) {
        console.warn("Cannot delete default roles");
        return;
      }

      const newRoles = state.roles.filter((role) => role.id !== id);
      await AsyncStorage.setItem(ROLES_STORAGE_KEY, JSON.stringify(newRoles));
      set({ roles: newRoles });
    } catch (error) {
      console.error("Error deleting role:", error);
    }
  },

  incrementUsage: async (id: string) => {
    try {
      const state = get();
      const newRoles = state.roles.map((role) =>
        role.id === id
          ? { ...role, usageCount: role.usageCount + 1, updatedAt: new Date() }
          : role
      );
      await Promise.all([
        AsyncStorage.setItem(ROLES_STORAGE_KEY, JSON.stringify(newRoles)),
        AsyncStorage.setItem(ROLES_VERSION_KEY, ROLES_SCHEMA_VERSION),
      ]);
      set({ roles: newRoles });
    } catch (error) {
      console.error("Error incrementing usage:", error);
    }
  },

  getDefaultRoles: () => {
    return get().roles.filter((role) => !role.isCustom);
  },
}));
