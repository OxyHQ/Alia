import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const NATIVE_PRODUCT_AGENT_IDENTITY = Object.freeze({
  schemaVersion: 1,
  oxyOrganizationId: '69b2d3df5d12f58c9800d651',
  agents: Object.freeze({
    sindi: Object.freeze({
      product: 'homiio' as const,
      projectAccountId: '01a0646a-078f-72ea-8759-86326484a7e0',
      botAccountId: '01a0646a-078f-7974-9645-a5e8be237f47',
      agentId: '01a0646a-078f-7514-9800-9f43ceed7df8',
      bindingApplicationId: '6a2f851751b784a86fd0e922',
      capabilityGrants: Object.freeze(['web'] as const),
      prompt: Object.freeze({
        source: 'Homiio/packages/backend/routes/ai.ts#SINDI_SYSTEM_PROMPT',
        file: 'native-product-prompts/sindi.md',
        normalization: 'trim' as const,
        sha256: 'e343b294c14ca519f8edb66552d00eb11c9386f2ec42b41ea1ff145cb6e958e0',
      }),
    }),
    clarity: Object.freeze({
      product: 'clarity' as const,
      projectAccountId: '01a0646a-078f-7f53-848d-a0f82d9f7fa6',
      botAccountId: '01a0646a-078f-7120-a993-a03c180c81b0',
      agentId: '01a0646a-078f-7642-95ef-439952f4f3f9',
      bindingApplicationId: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
      capabilityGrants: Object.freeze(['web', 'artifacts', 'memory'] as const),
      prompt: Object.freeze({
        source: 'Clarity/packages/backend/prompts/base.md',
        file: 'native-product-prompts/clarity.md',
        normalization: 'bytes' as const,
        sha256: 'e261b272d30a2f99f14de50c2c7fd9fc4990e7df5b1db20c2f3d7ceaf8647f09',
      }),
    }),
  }),
});

export type NativeProductAgentKey = keyof typeof NATIVE_PRODUCT_AGENT_IDENTITY.agents;

const NATIVE_PRODUCT_AGENT_IDS = new Set<string>(
  Object.values(NATIVE_PRODUCT_AGENT_IDENTITY.agents).map((agent) => agent.agentId),
);

/** Reserved rows remain bootstrap-managed even after rollback clears their app binding. */
export function isNativeProductAgentId(id: string): boolean {
  return NATIVE_PRODUCT_AGENT_IDS.has(id);
}

export interface LoadedNativeProductAgentSpec {
  key: NativeProductAgentKey;
  product: 'homiio' | 'clarity';
  projectAccountId: string;
  botAccountId: string;
  agentId: string;
  bindingApplicationId: string;
  capabilityGrants: readonly string[];
  prompt: {
    source: string;
    sha256: string;
    content: string;
  };
  row: {
    id: string;
    oxyAccountId: string;
    ownerOxyAccountId: string;
    applicationId: string;
    tagline: string;
    description: string;
    authorOxyUserId: string;
    category: string;
    tags: readonly string[];
    capabilityGrants: readonly string[];
    isPublished: false;
    status: 'active';
    access: 'private';
    systemPrompt: string;
    allowedModels: readonly string[];
    archetype: 'general';
    archetypeConfig: null;
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function loadPrompt(key: NativeProductAgentKey): { content: string; source: string; sha256: string } {
  const prompt = NATIVE_PRODUCT_AGENT_IDENTITY.agents[key].prompt;
  const raw = readFileSync(new URL(prompt.file, import.meta.url), 'utf8');
  const content = prompt.normalization === 'trim' ? raw.trim() : raw;
  const actual = sha256(content);
  if (actual !== prompt.sha256) {
    throw new Error(`${key} prompt drift: expected ${prompt.sha256}, observed ${actual}`);
  }
  return { content, source: prompt.source, sha256: actual };
}

/** Full non-secret desired state. Names are display data only; no lookup uses them. */
export function loadNativeProductAgentSpecs(): readonly LoadedNativeProductAgentSpec[] {
  const sindi = NATIVE_PRODUCT_AGENT_IDENTITY.agents.sindi;
  const clarity = NATIVE_PRODUCT_AGENT_IDENTITY.agents.clarity;
  const values = [
    {
      key: 'sindi' as const,
      ...sindi,
      prompt: loadPrompt('sindi'),
      row: {
        id: sindi.agentId,
        oxyAccountId: sindi.botAccountId,
        ownerOxyAccountId: sindi.projectAccountId,
        applicationId: sindi.bindingApplicationId,
        tagline: 'Tenant-rights and Homiio housing assistant',
        description: 'Sindi answers housing questions and helps people use Homiio.',
        authorOxyUserId: NATIVE_PRODUCT_AGENT_IDENTITY.oxyOrganizationId,
        category: 'housing',
        tags: ['homiio', 'housing', 'tenant-rights'],
        capabilityGrants: [...sindi.capabilityGrants],
        isPublished: false as const,
        status: 'active' as const,
        access: 'private' as const,
        systemPrompt: loadPrompt('sindi').content,
        allowedModels: ['kaana-v1', 'kaana-v1-pro'],
        archetype: 'general' as const,
        archetypeConfig: null,
      },
    },
    {
      key: 'clarity' as const,
      ...clarity,
      prompt: loadPrompt('clarity'),
      row: {
        id: clarity.agentId,
        oxyAccountId: clarity.botAccountId,
        ownerOxyAccountId: clarity.projectAccountId,
        applicationId: clarity.bindingApplicationId,
        tagline: 'Search and research with cited sources',
        description: 'Clarity researches current information and produces source-backed answers.',
        authorOxyUserId: NATIVE_PRODUCT_AGENT_IDENTITY.oxyOrganizationId,
        category: 'research',
        tags: ['clarity', 'search', 'research'],
        capabilityGrants: [...clarity.capabilityGrants],
        isPublished: false as const,
        status: 'active' as const,
        access: 'private' as const,
        systemPrompt: loadPrompt('clarity').content,
        allowedModels: ['kaana-v1', 'kaana-v1-pro'],
        archetype: 'general' as const,
        archetypeConfig: null,
      },
    },
  ] satisfies LoadedNativeProductAgentSpec[];
  return values;
}

export function nativeProductAgentHandoffManifest() {
  return {
    schemaVersion: NATIVE_PRODUCT_AGENT_IDENTITY.schemaVersion,
    oxyOrganizationId: NATIVE_PRODUCT_AGENT_IDENTITY.oxyOrganizationId,
    agents: loadNativeProductAgentSpecs().map((spec) => ({
      id: spec.agentId,
      oxyAccountId: spec.botAccountId,
      ownerOxyAccountId: spec.projectAccountId,
      applicationId: spec.bindingApplicationId,
      product: spec.product,
      visibility: 'private' as const,
      capabilityGrants: [...spec.capabilityGrants],
      systemPrompt: { source: spec.prompt.source, sha256: spec.prompt.sha256 },
    })),
  };
}
