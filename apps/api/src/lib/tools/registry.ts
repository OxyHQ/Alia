import type { Tool, ToolSet } from 'ai';

export type PlanTier = 'free' | 'pro' | 'business';

export interface ToolRegistration {
  name: string;
  description: string;
  tool: Tool<any, any> | ((...args: any[]) => Tool<any, any>);
  requiredPlan?: PlanTier;           // minimum plan required (undefined = available to all)
  requiredCapabilities?: string[];   // e.g., ['tools', 'vision']
  enabledByDefault: boolean;
  category?: string;                 // e.g., 'search', 'memory', 'communication', 'admin'
}

const registry: Map<string, ToolRegistration> = new Map();

const PLAN_HIERARCHY: Record<string, number> = { free: 0, pro: 1, business: 2 };

export function registerTool(reg: ToolRegistration): void {
  registry.set(reg.name, reg);
}

export function getTool(name: string): ToolRegistration | undefined {
  return registry.get(name);
}

export function getAllRegisteredTools(): ToolRegistration[] {
  return Array.from(registry.values());
}

/**
 * Returns true if the given user plan meets or exceeds the required plan tier.
 */
export function planMeetsRequirement(userPlan: string, requiredPlan?: PlanTier): boolean {
  if (!requiredPlan) return true;
  const userLevel = PLAN_HIERARCHY[userPlan] ?? 0;
  const requiredLevel = PLAN_HIERARCHY[requiredPlan] ?? 0;
  return userLevel >= requiredLevel;
}

/**
 * Get static (non-factory) tools available for a given context.
 * Filters by user plan and model capabilities.
 *
 * Factory tools (functions that need context like userId) are excluded here;
 * they must be instantiated separately by the caller and merged into the ToolSet.
 */
export function getToolsForContext(
  userPlan: string,
  modelCapabilities?: string[],
): ToolSet {
  const userPlanLevel = PLAN_HIERARCHY[userPlan] ?? 0;
  const capabilities = new Set(modelCapabilities || []);

  const tools: ToolSet = {};

  for (const [name, reg] of registry) {
    if (!reg.enabledByDefault) continue;

    // Check plan requirement
    if (reg.requiredPlan) {
      const requiredLevel = PLAN_HIERARCHY[reg.requiredPlan] ?? 0;
      if (userPlanLevel < requiredLevel) continue;
    }

    // Check model capabilities
    if (reg.requiredCapabilities?.length) {
      const hasAll = reg.requiredCapabilities.every(cap => capabilities.has(cap));
      if (!hasAll) continue;
    }

    // Only include static tools (not factory functions).
    // Factory functions need to be called with context (userId, apiKey, deviceInfo, etc.)
    // and are handled by the caller.
    if (typeof reg.tool !== 'function') {
      tools[name] = reg.tool;
    }
  }

  return tools;
}

/**
 * Get all factory-type tool registrations available for a given context.
 * These are tools whose `tool` field is a function that must be called with
 * context-specific arguments before use.
 */
export function getFactoryToolsForContext(
  userPlan: string,
  modelCapabilities?: string[],
): ToolRegistration[] {
  const userPlanLevel = PLAN_HIERARCHY[userPlan] ?? 0;
  const capabilities = new Set(modelCapabilities || []);

  const result: ToolRegistration[] = [];

  for (const [, reg] of registry) {
    if (!reg.enabledByDefault) continue;

    if (reg.requiredPlan) {
      const requiredLevel = PLAN_HIERARCHY[reg.requiredPlan] ?? 0;
      if (userPlanLevel < requiredLevel) continue;
    }

    if (reg.requiredCapabilities?.length) {
      const hasAll = reg.requiredCapabilities.every(cap => capabilities.has(cap));
      if (!hasAll) continue;
    }

    if (typeof reg.tool === 'function') {
      result.push(reg);
    }
  }

  return result;
}
