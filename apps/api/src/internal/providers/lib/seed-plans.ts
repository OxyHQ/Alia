/**
 * Seed Plan collection with default subscription plans.
 * Uses $setOnInsert for idempotency — re-running never overwrites admin edits.
 */

import { Plan, type IFeatureGroup } from '../models/plan.js';
import { connectDB } from './db.js';

interface PlanSeed {
  planId: string;
  name: string;
  product: 'alia' | 'codea';
  creditsPerMonth: number;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  subtitle: string;
  creditsLabel: string;
  isFeatured: boolean;
  sortOrder: number;
  isFree: boolean;
  features: IFeatureGroup[];
  modelIds: string[];
}

const SEED_PLANS: PlanSeed[] = [
  // ─── Alia Plans ───────────────────────────────────────────
  {
    planId: 'free',
    name: 'Free',
    product: 'alia',
    creditsPerMonth: 0,
    monthlyPrice: 0,
    annualPrice: 0,
    currency: 'usd',
    subtitle: 'subscribe.freeUsage',
    creditsLabel: '300 credits / day',
    isFeatured: false,
    sortOrder: 0,
    isFree: true,
    modelIds: ['alia-lite', 'alia-v1', 'alia-v1-audio'],
    features: [
      {
        category: 'Credits',
        items: [
          { label: '300 credits / day', description: 'Resets to 300 each day — unused credits do not carry over' },
        ],
      },
      {
        category: 'Features',
        items: [
          { label: 'Chat & Q&A', description: 'Conversational AI for everyday questions' },
          { label: 'Text generation', description: 'Write emails, summaries, and content' },
          { label: 'Basic research', description: 'Simple information lookup and analysis' },
          { label: 'Memory', description: 'Alia remembers context across conversations' },
          { label: 'Channels', description: 'Connect via Telegram' },
        ],
      },
      {
        category: 'Limits',
        items: [
          { label: '5 concurrent tasks' },
          { label: 'Standard response length' },
        ],
      },
    ],
  },
  {
    planId: 'go',
    name: 'Go',
    product: 'alia',
    creditsPerMonth: 4000,
    monthlyPrice: 399,
    annualPrice: 3830,
    currency: 'usd',
    subtitle: 'subscribe.goUsage',
    creditsLabel: '4,000 credits / mo',
    isFeatured: false,
    sortOrder: 1,
    isFree: false,
    modelIds: ['alia-v1-codea', 'alia-v1-vision', 'alia-v1-browser', 'alia-v1-cowork', 'alia-v1-multimodal', 'alia-v1-voice'],
    features: [
      {
        category: 'Credits',
        items: [
          { label: '4,000 credits / month', description: 'Monthly allowance plus 300 daily refresh on top' },
        ],
      },
      {
        category: 'Features',
        items: [
          { label: 'Everything in Free' },
          { label: 'File uploads & analysis', description: 'Upload and process documents, images, and more' },
          { label: 'Conversation history sync', description: 'Access your chats across all devices' },
          { label: 'Agents', description: 'Autonomous AI agents that complete tasks for you' },
          { label: 'Skills', description: 'Extend Alia with custom capabilities' },
          { label: 'Channels', description: 'Telegram, WhatsApp, and Discord integrations' },
          { label: 'Roles & personas', description: 'Customize Alia behavior and personality' },
          { label: 'Early access', description: 'Try new beta features before everyone else' },
        ],
      },
      {
        category: 'Limits',
        items: [
          { label: '10 concurrent tasks' },
          { label: 'Longer responses' },
        ],
      },
    ],
  },
  {
    planId: 'pro',
    name: 'Pro',
    product: 'alia',
    creditsPerMonth: 10000,
    monthlyPrice: 999,
    annualPrice: 9590,
    currency: 'usd',
    subtitle: 'subscribe.proUsage',
    creditsLabel: '10,000 credits / mo',
    isFeatured: true,
    sortOrder: 2,
    isFree: false,
    modelIds: ['alia-v1-pro', 'alia-v1-thinking', 'alia-v1-pro-max', 'alia-v1-voice-pro'],
    features: [
      {
        category: 'Credits',
        items: [
          { label: '10,000 credits / month', description: 'Monthly allowance plus 300 daily refresh on top' },
        ],
      },
      {
        category: 'Features',
        items: [
          { label: 'Everything in Go' },
          { label: 'Web search & live data', description: 'Search the web and access real-time information' },
          { label: 'Advanced research', description: 'Deep analysis with citations and sources' },
          { label: 'Custom instructions', description: 'Set persistent preferences and guidelines' },
          { label: 'Automations', description: 'Schedule recurring tasks and workflows' },
          { label: 'Canvas', description: 'Visual workspace for brainstorming and planning' },
          { label: 'File management', description: 'Organize, search, and process uploaded files' },
          { label: 'Memory import/export', description: 'Back up and transfer your knowledge base' },
        ],
      },
      {
        category: 'Limits',
        items: [
          { label: '20 concurrent tasks' },
          { label: 'Extended response length' },
        ],
      },
    ],
  },
  {
    planId: 'max',
    name: 'Max',
    product: 'alia',
    creditsPerMonth: 50000,
    monthlyPrice: 4999,
    annualPrice: 47990,
    currency: 'usd',
    subtitle: 'subscribe.maxUsage',
    creditsLabel: '50,000 credits / mo',
    isFeatured: false,
    sortOrder: 3,
    isFree: false,
    modelIds: [],
    features: [
      {
        category: 'Credits',
        items: [
          { label: '50,000 credits / month', description: 'Monthly allowance plus 300 daily refresh on top' },
        ],
      },
      {
        category: 'Features',
        items: [
          { label: 'Everything in Pro' },
          { label: 'Extended context windows', description: 'Handle larger documents and longer conversations' },
          { label: 'Extended output length', description: 'Generate longer and more detailed responses' },
          { label: 'Deep analysis', description: 'Multi-step research with comprehensive reports' },
          { label: 'Batch processing', description: 'Process multiple tasks simultaneously' },
          { label: 'Language enforcement', description: 'Force responses in your preferred language' },
          { label: 'Advanced automations', description: 'Complex multi-step scheduled workflows' },
        ],
      },
      {
        category: 'Limits',
        items: [
          { label: 'Dedicated capacity' },
          { label: '50 concurrent tasks' },
        ],
      },
    ],
  },
  {
    planId: 'ultra',
    name: 'Ultra',
    product: 'alia',
    creditsPerMonth: 100000,
    monthlyPrice: 9999,
    annualPrice: 95990,
    currency: 'usd',
    subtitle: 'subscribe.ultraUsage',
    creditsLabel: '100,000 credits / mo',
    isFeatured: false,
    sortOrder: 4,
    isFree: false,
    modelIds: [],
    features: [
      {
        category: 'Credits',
        items: [
          { label: '100,000 credits / month', description: 'Monthly allowance plus 300 daily refresh on top' },
        ],
      },
      {
        category: 'Features',
        items: [
          { label: 'Everything in Max' },
          { label: 'Maximum context & output', description: 'Largest possible context windows and response length' },
          { label: 'Priority support', description: 'Faster response times from the Alia team' },
          { label: 'API access', description: 'Programmatic access to Alia models via REST API' },
          { label: 'Heavy-workload automation', description: 'Run demanding batch and automation jobs' },
        ],
      },
      {
        category: 'Limits',
        items: [
          { label: 'Dedicated heavy-workload capacity' },
          { label: '100 concurrent tasks' },
        ],
      },
    ],
  },

  // ─── Codea Plans ──────────────────────────────────────────
  {
    planId: 'codea-pro',
    name: 'Codea Pro',
    product: 'codea',
    creditsPerMonth: 10000,
    monthlyPrice: 999,
    annualPrice: 9590,
    currency: 'usd',
    subtitle: 'subscribe.codeaProUsage',
    creditsLabel: '10,000 credits / mo',
    isFeatured: false,
    sortOrder: 0,
    isFree: false,
    modelIds: ['alia-v1-codea', 'alia-v1-pro', 'alia-v1-thinking'],
    features: [
      {
        category: 'Credits',
        items: [
          { label: '10,000 credits / month', description: 'Shared with your Alia plan — 300 daily refresh on top' },
        ],
      },
      {
        category: 'Features',
        items: [
          { label: 'AI code completions', description: 'Intelligent autocomplete as you type' },
          { label: 'Chat-based assistance', description: 'Ask questions about your code in natural language' },
          { label: 'Multi-file editing', description: 'Apply changes across multiple files at once' },
          { label: 'Codebase-aware context', description: 'Understands your project structure and dependencies' },
          { label: 'Code explanations', description: 'Get clear explanations of complex code' },
          { label: 'Bug detection', description: 'Identify and fix issues before they ship' },
          { label: 'Refactoring', description: 'Improve code structure and readability' },
        ],
      },
      {
        category: 'Limits',
        items: [
          { label: '20 concurrent tasks' },
          { label: 'Extended context windows' },
        ],
      },
    ],
  },
  {
    planId: 'codea-max',
    name: 'Codea Max',
    product: 'codea',
    creditsPerMonth: 50000,
    monthlyPrice: 4999,
    annualPrice: 47990,
    currency: 'usd',
    subtitle: 'subscribe.codeaMaxUsage',
    creditsLabel: '50,000 credits / mo',
    isFeatured: true,
    sortOrder: 1,
    isFree: false,
    modelIds: ['alia-v1-codea', 'alia-v1-pro', 'alia-v1-thinking'],
    features: [
      {
        category: 'Credits',
        items: [
          { label: '50,000 credits / month', description: 'Shared with your Alia plan — 300 daily refresh on top' },
        ],
      },
      {
        category: 'Features',
        items: [
          { label: 'Everything in Codea Pro' },
          { label: 'Advanced code analysis', description: 'Deep analysis of architecture and performance' },
          { label: 'Batch code transformations', description: 'Apply changes across your entire codebase' },
          { label: 'Project scaffolding', description: 'Generate boilerplate and project templates' },
          { label: 'Test generation', description: 'Automatically create unit and integration tests' },
          { label: 'Documentation generation', description: 'Auto-generate docs from your codebase' },
          { label: 'CLI access', description: 'Use Codea directly from your terminal' },
        ],
      },
      {
        category: 'Limits',
        items: [
          { label: 'Dedicated capacity' },
          { label: '50 concurrent tasks' },
          { label: 'Maximum context windows' },
        ],
      },
    ],
  },
];

export async function seedPlans(): Promise<{ seeded: number; skipped: number }> {
  await connectDB();

  let seeded = 0;
  let skipped = 0;

  for (const planData of SEED_PLANS) {
    try {
      const result = await Plan.updateOne(
        { planId: planData.planId },
        {
          $setOnInsert: {
            name: planData.name,
            product: planData.product,
            creditsPerMonth: planData.creditsPerMonth,
            monthlyPrice: planData.monthlyPrice,
            annualPrice: planData.annualPrice,
            currency: planData.currency,
            subtitle: planData.subtitle,
            creditsLabel: planData.creditsLabel,
            isFeatured: planData.isFeatured,
            sortOrder: planData.sortOrder,
            isFree: planData.isFree,
            features: planData.features,
            modelIds: planData.modelIds,
            isActive: true,
          },
        },
        { upsert: true }
      );

      if (result.upsertedCount > 0) {
        seeded++;
        console.log(`[Seed] Created Plan: ${planData.planId} (${planData.product})`);
      } else {
        skipped++;
      }
    } catch (error: any) {
      if (error.code === 11000) {
        skipped++;
      } else {
        console.error(`[Seed] Error seeding plan ${planData.planId}:`, error.message);
      }
    }
  }

  console.log(`[Seed] Plan seeding complete: ${seeded} created, ${skipped} skipped/existing`);
  return { seeded, skipped };
}
