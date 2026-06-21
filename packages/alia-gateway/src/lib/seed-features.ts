/**
 * Seed Feature and PlanFeature collections.
 * Features define the canonical set of capabilities.
 * PlanFeatures map which features each plan includes.
 *
 * Uses $setOnInsert for features (admin can edit labels later).
 * PlanFeature mappings are always overwritten from code (source of truth).
 */

import { Feature } from '../models/feature.js';
import { PlanFeature } from '../models/plan-feature.js';
import { connectDB } from './db';
import { log } from './logger';

// ─── Feature seed data ──────────────────────────────────────

interface FeatureSeed {
  featureId: string;
  label: string;
  description?: string;
  category: string;
  featureType: 'boolean' | 'limit';
  sortOrder: number;
  isVisibleOnPricing: boolean;
}

const FEATURES: FeatureSeed[] = [
  // ── Credits (category for display) ──
  { featureId: 'credits-display', label: 'Credits', description: 'Monthly and daily credit allocation', category: 'Credits', featureType: 'boolean', sortOrder: 0, isVisibleOnPricing: true },

  // ── Features ──
  { featureId: 'chat-qa', label: 'Chat & Q&A', description: 'Conversational AI for everyday questions', category: 'Features', featureType: 'boolean', sortOrder: 0, isVisibleOnPricing: true },
  { featureId: 'text-generation', label: 'Text generation', description: 'Write emails, summaries, and content', category: 'Features', featureType: 'boolean', sortOrder: 1, isVisibleOnPricing: true },
  { featureId: 'basic-research', label: 'Basic research', description: 'Simple information lookup and analysis', category: 'Features', featureType: 'boolean', sortOrder: 2, isVisibleOnPricing: true },
  { featureId: 'memory', label: 'Memory', description: 'Alia remembers context across conversations', category: 'Features', featureType: 'boolean', sortOrder: 3, isVisibleOnPricing: true },
  { featureId: 'file-uploads', label: 'File uploads & analysis', description: 'Upload and process documents, images, and more', category: 'Features', featureType: 'boolean', sortOrder: 4, isVisibleOnPricing: true },
  { featureId: 'conversation-sync', label: 'Conversation history sync', description: 'Access your chats across all devices', category: 'Features', featureType: 'boolean', sortOrder: 5, isVisibleOnPricing: true },
  { featureId: 'agents', label: 'Agents', description: 'Autonomous AI agents that complete tasks for you', category: 'Features', featureType: 'boolean', sortOrder: 6, isVisibleOnPricing: true },
  { featureId: 'skills', label: 'Skills', description: 'Extend Alia with custom capabilities', category: 'Features', featureType: 'boolean', sortOrder: 7, isVisibleOnPricing: true },
  { featureId: 'roles-personas', label: 'Roles & personas', description: 'Customize Alia behavior and personality', category: 'Features', featureType: 'boolean', sortOrder: 8, isVisibleOnPricing: true },
  { featureId: 'early-access', label: 'Early access', description: 'Try new beta features before everyone else', category: 'Features', featureType: 'boolean', sortOrder: 9, isVisibleOnPricing: true },
  { featureId: 'web-search', label: 'Web search & live data', description: 'Search the web and access real-time information', category: 'Features', featureType: 'boolean', sortOrder: 10, isVisibleOnPricing: true },
  { featureId: 'advanced-research', label: 'Advanced research', description: 'Deep analysis with citations and sources', category: 'Features', featureType: 'boolean', sortOrder: 11, isVisibleOnPricing: true },
  { featureId: 'custom-instructions', label: 'Custom instructions', description: 'Set persistent preferences and guidelines', category: 'Features', featureType: 'boolean', sortOrder: 12, isVisibleOnPricing: true },
  { featureId: 'automations', label: 'Automations', description: 'Schedule recurring tasks and workflows', category: 'Features', featureType: 'boolean', sortOrder: 13, isVisibleOnPricing: true },
  { featureId: 'canvas', label: 'Canvas', description: 'Visual workspace for brainstorming and planning', category: 'Features', featureType: 'boolean', sortOrder: 14, isVisibleOnPricing: true },
  { featureId: 'file-management', label: 'File management', description: 'Organize, search, and process uploaded files', category: 'Features', featureType: 'boolean', sortOrder: 15, isVisibleOnPricing: true },
  { featureId: 'memory-import-export', label: 'Memory import/export', description: 'Back up and transfer your knowledge base', category: 'Features', featureType: 'boolean', sortOrder: 16, isVisibleOnPricing: true },
  { featureId: 'deep-analysis', label: 'Deep analysis', description: 'Multi-step research with comprehensive reports', category: 'Features', featureType: 'boolean', sortOrder: 17, isVisibleOnPricing: true },
  { featureId: 'batch-processing', label: 'Batch processing', description: 'Process multiple tasks simultaneously', category: 'Features', featureType: 'boolean', sortOrder: 18, isVisibleOnPricing: true },
  { featureId: 'language-enforcement', label: 'Language enforcement', description: 'Force responses in your preferred language', category: 'Features', featureType: 'boolean', sortOrder: 19, isVisibleOnPricing: true },
  { featureId: 'advanced-automations', label: 'Advanced automations', description: 'Complex multi-step scheduled workflows', category: 'Features', featureType: 'boolean', sortOrder: 20, isVisibleOnPricing: true },
  { featureId: 'api-access', label: 'API access', description: 'Programmatic access to Alia models via REST API', category: 'Features', featureType: 'boolean', sortOrder: 21, isVisibleOnPricing: true },
  { featureId: 'priority-support', label: 'Priority support', description: 'Faster response times from the Alia team', category: 'Features', featureType: 'boolean', sortOrder: 22, isVisibleOnPricing: true },
  { featureId: 'voice-mode', label: 'Voice conversations', description: 'Real-time voice conversations with Alia', category: 'Features', featureType: 'boolean', sortOrder: 23, isVisibleOnPricing: true },
  { featureId: 'agent-mode', label: 'Agent mode', description: 'Autonomous AI agents that browse and take actions', category: 'Features', featureType: 'boolean', sortOrder: 24, isVisibleOnPricing: true },
  { featureId: 'deep-research', label: 'Deep research', description: 'Multi-step deep research with comprehensive reports', category: 'Features', featureType: 'boolean', sortOrder: 25, isVisibleOnPricing: true },
  { featureId: 'shopping-research', label: 'Shopping research', description: 'Product comparison and shopping assistance', category: 'Features', featureType: 'boolean', sortOrder: 26, isVisibleOnPricing: true },
  { featureId: 'thinking-mode', label: 'Extended thinking', description: 'Advanced reasoning with step-by-step thinking', category: 'Features', featureType: 'boolean', sortOrder: 27, isVisibleOnPricing: true },

  // ── Channels ──
  { featureId: 'channels-telegram', label: 'Telegram', description: 'Connect via Telegram', category: 'Channels', featureType: 'boolean', sortOrder: 0, isVisibleOnPricing: true },
  { featureId: 'channels-whatsapp', label: 'WhatsApp', description: 'Connect via WhatsApp', category: 'Channels', featureType: 'boolean', sortOrder: 1, isVisibleOnPricing: true },
  { featureId: 'channels-discord', label: 'Discord', description: 'Connect via Discord', category: 'Channels', featureType: 'boolean', sortOrder: 2, isVisibleOnPricing: true },

  // ── Limits ──
  { featureId: 'concurrent-tasks', label: 'Concurrent tasks', description: 'Number of simultaneous tasks', category: 'Limits', featureType: 'limit', sortOrder: 0, isVisibleOnPricing: true },
  { featureId: 'response-length', label: 'Response length', description: 'Maximum response output length', category: 'Limits', featureType: 'limit', sortOrder: 1, isVisibleOnPricing: true },
  { featureId: 'context-window', label: 'Context window', description: 'Maximum conversation context size', category: 'Limits', featureType: 'limit', sortOrder: 2, isVisibleOnPricing: true },
];

// ─── PlanFeature mappings ────────────────────────────────────

interface PlanFeatureSeed {
  planId: string;
  featureId: string;
  enabled: boolean;
  limitValue?: number;
  displayLabel?: string;
  displayDescription?: string;
}

const PLAN_FEATURES: PlanFeatureSeed[] = [
  // ═══ Free Plan ═══
  { planId: 'free', featureId: 'credits-display', enabled: true, displayLabel: '300 credits / day', displayDescription: 'Resets to 300 each day — unused credits do not carry over' },
  { planId: 'free', featureId: 'chat-qa', enabled: true },
  { planId: 'free', featureId: 'text-generation', enabled: true },
  { planId: 'free', featureId: 'basic-research', enabled: true },
  { planId: 'free', featureId: 'memory', enabled: true },
  { planId: 'free', featureId: 'channels-telegram', enabled: true },
  { planId: 'free', featureId: 'concurrent-tasks', enabled: true, limitValue: 5, displayLabel: '5 concurrent tasks' },
  { planId: 'free', featureId: 'response-length', enabled: true, limitValue: 1, displayLabel: 'Standard response length' },

  // ═══ Go Plan ═══
  { planId: 'go', featureId: 'credits-display', enabled: true, displayLabel: '4,000 credits / month', displayDescription: 'Monthly allowance plus 300 daily refresh on top' },
  { planId: 'go', featureId: 'chat-qa', enabled: true },
  { planId: 'go', featureId: 'text-generation', enabled: true },
  { planId: 'go', featureId: 'basic-research', enabled: true },
  { planId: 'go', featureId: 'memory', enabled: true },
  { planId: 'go', featureId: 'file-uploads', enabled: true },
  { planId: 'go', featureId: 'conversation-sync', enabled: true },
  { planId: 'go', featureId: 'agents', enabled: true },
  { planId: 'go', featureId: 'skills', enabled: true },
  { planId: 'go', featureId: 'roles-personas', enabled: true },
  { planId: 'go', featureId: 'early-access', enabled: true },
  { planId: 'go', featureId: 'channels-telegram', enabled: true },
  { planId: 'go', featureId: 'channels-whatsapp', enabled: true },
  { planId: 'go', featureId: 'channels-discord', enabled: true },
  { planId: 'go', featureId: 'voice-mode', enabled: true },
  { planId: 'go', featureId: 'agent-mode', enabled: true },
  { planId: 'go', featureId: 'deep-research', enabled: true },
  { planId: 'go', featureId: 'shopping-research', enabled: true },
  { planId: 'go', featureId: 'concurrent-tasks', enabled: true, limitValue: 10, displayLabel: '10 concurrent tasks' },
  { planId: 'go', featureId: 'response-length', enabled: true, limitValue: 2, displayLabel: 'Longer responses' },

  // ═══ Pro Plan ═══
  { planId: 'pro', featureId: 'credits-display', enabled: true, displayLabel: '10,000 credits / month', displayDescription: 'Monthly allowance plus 300 daily refresh on top' },
  { planId: 'pro', featureId: 'chat-qa', enabled: true },
  { planId: 'pro', featureId: 'text-generation', enabled: true },
  { planId: 'pro', featureId: 'basic-research', enabled: true },
  { planId: 'pro', featureId: 'memory', enabled: true },
  { planId: 'pro', featureId: 'file-uploads', enabled: true },
  { planId: 'pro', featureId: 'conversation-sync', enabled: true },
  { planId: 'pro', featureId: 'agents', enabled: true },
  { planId: 'pro', featureId: 'skills', enabled: true },
  { planId: 'pro', featureId: 'roles-personas', enabled: true },
  { planId: 'pro', featureId: 'early-access', enabled: true },
  { planId: 'pro', featureId: 'web-search', enabled: true },
  { planId: 'pro', featureId: 'advanced-research', enabled: true },
  { planId: 'pro', featureId: 'custom-instructions', enabled: true },
  { planId: 'pro', featureId: 'automations', enabled: true },
  { planId: 'pro', featureId: 'canvas', enabled: true },
  { planId: 'pro', featureId: 'file-management', enabled: true },
  { planId: 'pro', featureId: 'memory-import-export', enabled: true },
  { planId: 'pro', featureId: 'voice-mode', enabled: true },
  { planId: 'pro', featureId: 'agent-mode', enabled: true },
  { planId: 'pro', featureId: 'deep-research', enabled: true },
  { planId: 'pro', featureId: 'shopping-research', enabled: true },
  { planId: 'pro', featureId: 'thinking-mode', enabled: true },
  { planId: 'pro', featureId: 'channels-telegram', enabled: true },
  { planId: 'pro', featureId: 'channels-whatsapp', enabled: true },
  { planId: 'pro', featureId: 'channels-discord', enabled: true },
  { planId: 'pro', featureId: 'concurrent-tasks', enabled: true, limitValue: 20, displayLabel: '20 concurrent tasks' },
  { planId: 'pro', featureId: 'response-length', enabled: true, limitValue: 3, displayLabel: 'Extended response length' },

  // ═══ Max Plan ═══
  { planId: 'max', featureId: 'credits-display', enabled: true, displayLabel: '50,000 credits / month', displayDescription: 'Monthly allowance plus 300 daily refresh on top' },
  { planId: 'max', featureId: 'chat-qa', enabled: true },
  { planId: 'max', featureId: 'text-generation', enabled: true },
  { planId: 'max', featureId: 'basic-research', enabled: true },
  { planId: 'max', featureId: 'memory', enabled: true },
  { planId: 'max', featureId: 'file-uploads', enabled: true },
  { planId: 'max', featureId: 'conversation-sync', enabled: true },
  { planId: 'max', featureId: 'agents', enabled: true },
  { planId: 'max', featureId: 'skills', enabled: true },
  { planId: 'max', featureId: 'roles-personas', enabled: true },
  { planId: 'max', featureId: 'early-access', enabled: true },
  { planId: 'max', featureId: 'web-search', enabled: true },
  { planId: 'max', featureId: 'advanced-research', enabled: true },
  { planId: 'max', featureId: 'custom-instructions', enabled: true },
  { planId: 'max', featureId: 'automations', enabled: true },
  { planId: 'max', featureId: 'canvas', enabled: true },
  { planId: 'max', featureId: 'file-management', enabled: true },
  { planId: 'max', featureId: 'memory-import-export', enabled: true },
  { planId: 'max', featureId: 'deep-analysis', enabled: true },
  { planId: 'max', featureId: 'batch-processing', enabled: true },
  { planId: 'max', featureId: 'language-enforcement', enabled: true },
  { planId: 'max', featureId: 'advanced-automations', enabled: true },
  { planId: 'max', featureId: 'voice-mode', enabled: true },
  { planId: 'max', featureId: 'agent-mode', enabled: true },
  { planId: 'max', featureId: 'deep-research', enabled: true },
  { planId: 'max', featureId: 'shopping-research', enabled: true },
  { planId: 'max', featureId: 'thinking-mode', enabled: true },
  { planId: 'max', featureId: 'context-window', enabled: true, limitValue: 2, displayLabel: 'Extended context windows' },
  { planId: 'max', featureId: 'channels-telegram', enabled: true },
  { planId: 'max', featureId: 'channels-whatsapp', enabled: true },
  { planId: 'max', featureId: 'channels-discord', enabled: true },
  { planId: 'max', featureId: 'concurrent-tasks', enabled: true, limitValue: 50, displayLabel: '50 concurrent tasks' },
  { planId: 'max', featureId: 'response-length', enabled: true, limitValue: 4, displayLabel: 'Extended output length' },

  // ═══ Ultra Plan ═══
  { planId: 'ultra', featureId: 'credits-display', enabled: true, displayLabel: '100,000 credits / month', displayDescription: 'Monthly allowance plus 300 daily refresh on top' },
  { planId: 'ultra', featureId: 'chat-qa', enabled: true },
  { planId: 'ultra', featureId: 'text-generation', enabled: true },
  { planId: 'ultra', featureId: 'basic-research', enabled: true },
  { planId: 'ultra', featureId: 'memory', enabled: true },
  { planId: 'ultra', featureId: 'file-uploads', enabled: true },
  { planId: 'ultra', featureId: 'conversation-sync', enabled: true },
  { planId: 'ultra', featureId: 'agents', enabled: true },
  { planId: 'ultra', featureId: 'skills', enabled: true },
  { planId: 'ultra', featureId: 'roles-personas', enabled: true },
  { planId: 'ultra', featureId: 'early-access', enabled: true },
  { planId: 'ultra', featureId: 'web-search', enabled: true },
  { planId: 'ultra', featureId: 'advanced-research', enabled: true },
  { planId: 'ultra', featureId: 'custom-instructions', enabled: true },
  { planId: 'ultra', featureId: 'automations', enabled: true },
  { planId: 'ultra', featureId: 'canvas', enabled: true },
  { planId: 'ultra', featureId: 'file-management', enabled: true },
  { planId: 'ultra', featureId: 'memory-import-export', enabled: true },
  { planId: 'ultra', featureId: 'deep-analysis', enabled: true },
  { planId: 'ultra', featureId: 'batch-processing', enabled: true },
  { planId: 'ultra', featureId: 'language-enforcement', enabled: true },
  { planId: 'ultra', featureId: 'advanced-automations', enabled: true },
  { planId: 'ultra', featureId: 'api-access', enabled: true },
  { planId: 'ultra', featureId: 'priority-support', enabled: true },
  { planId: 'ultra', featureId: 'voice-mode', enabled: true },
  { planId: 'ultra', featureId: 'agent-mode', enabled: true },
  { planId: 'ultra', featureId: 'deep-research', enabled: true },
  { planId: 'ultra', featureId: 'shopping-research', enabled: true },
  { planId: 'ultra', featureId: 'thinking-mode', enabled: true },
  { planId: 'ultra', featureId: 'context-window', enabled: true, limitValue: 3, displayLabel: 'Maximum context windows' },
  { planId: 'ultra', featureId: 'channels-telegram', enabled: true },
  { planId: 'ultra', featureId: 'channels-whatsapp', enabled: true },
  { planId: 'ultra', featureId: 'channels-discord', enabled: true },
  { planId: 'ultra', featureId: 'concurrent-tasks', enabled: true, limitValue: 100, displayLabel: '100 concurrent tasks' },
  { planId: 'ultra', featureId: 'response-length', enabled: true, limitValue: 5, displayLabel: 'Maximum response length' },

  // ═══ Codea Pro ═══
  { planId: 'codea-pro', featureId: 'credits-display', enabled: true, displayLabel: '10,000 credits / month', displayDescription: 'Shared with your Alia plan — 300 daily refresh on top' },
  { planId: 'codea-pro', featureId: 'concurrent-tasks', enabled: true, limitValue: 20, displayLabel: '20 concurrent tasks' },
  { planId: 'codea-pro', featureId: 'context-window', enabled: true, limitValue: 2, displayLabel: 'Extended context windows' },

  // ═══ Codea Max ═══
  { planId: 'codea-max', featureId: 'credits-display', enabled: true, displayLabel: '50,000 credits / month', displayDescription: 'Shared with your Alia plan — 300 daily refresh on top' },
  { planId: 'codea-max', featureId: 'concurrent-tasks', enabled: true, limitValue: 50, displayLabel: '50 concurrent tasks' },
  { planId: 'codea-max', featureId: 'context-window', enabled: true, limitValue: 3, displayLabel: 'Maximum context windows' },
];

// ─── Seed functions ──────────────────────────────────────────

export async function seedFeatures(): Promise<{ seeded: number; skipped: number }> {
  await connectDB();

  let seeded = 0;
  let skipped = 0;

  for (const f of FEATURES) {
    try {
      const result = await Feature.updateOne(
        { featureId: f.featureId },
        {
          $setOnInsert: {
            label: f.label,
            description: f.description,
            category: f.category,
            featureType: f.featureType,
            sortOrder: f.sortOrder,
            isVisibleOnPricing: f.isVisibleOnPricing,
            isActive: true,
          },
        },
        { upsert: true }
      );

      if (result.upsertedCount > 0) {
        seeded++;
      } else {
        skipped++;
      }
    } catch (error: any) {
      if (error.code === 11000) {
        skipped++;
      } else {
        log.seed.error({ err: error, featureId: f.featureId }, 'Error seeding feature');
      }
    }
  }

  log.seed.info({ seeded, skipped }, 'Feature seeding complete');
  return { seeded, skipped };
}

export async function seedPlanFeatures(): Promise<{ upserted: number }> {
  await connectDB();

  const ops = PLAN_FEATURES.map((pf) => ({
    updateOne: {
      filter: { planId: pf.planId, featureId: pf.featureId },
      update: {
        $setOnInsert: {
          enabled: pf.enabled,
          limitValue: pf.limitValue,
          displayLabel: pf.displayLabel,
          displayDescription: pf.displayDescription,
        },
      },
      upsert: true,
    },
  }));

  const result = await PlanFeature.bulkWrite(ops);
  const upserted = result.upsertedCount;
  log.seed.info({ upserted }, 'PlanFeature seeding complete');
  return { upserted };
}
