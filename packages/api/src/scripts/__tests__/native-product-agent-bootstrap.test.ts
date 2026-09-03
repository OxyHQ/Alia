import { describe, expect, it } from 'vitest';
import {
  NATIVE_PRODUCT_AGENT_IDENTITY,
  isNativeProductAgentId,
  loadNativeProductAgentSpecs,
  nativeProductAgentHandoffManifest,
} from '../../config/native-product-agents.js';
import {
  verifyNativeProductAgentAuthority,
  type OxyNativeProductAuthorityReader,
} from '../../lib/native-product-agent-authority.js';
import {
  buildNativeProductAgentPlan,
  nativeProductAgentPlanSha256,
  type NativeProductAgentStoredState,
} from '../native-product-agent-bootstrap-plan.js';
import { assertOxyBootstrapOrigin } from '../bootstrap-native-product-agents.js';

const specs = loadNativeProductAgentSpecs();

function reader(overrides: {
  organizationId?: string;
  projectId?: string;
  botId?: string;
  botParent?: string;
  projectParent?: string;
  applicationOwner?: string;
  applicationId?: string;
} = {}): OxyNativeProductAuthorityReader {
  return {
    async getAccount(id) {
      if (id === NATIVE_PRODUCT_AGENT_IDENTITY.oxyOrganizationId) {
        return { accountId: overrides.organizationId ?? id, kind: 'organization', parentAccountId: 'platform-owner' };
      }
      const project = specs.find((spec) => spec.projectAccountId === id);
      if (project) {
        return {
          accountId: overrides.projectId ?? id,
          kind: 'project',
          parentAccountId: overrides.projectParent ?? NATIVE_PRODUCT_AGENT_IDENTITY.oxyOrganizationId,
        };
      }
      const bot = specs.find((spec) => spec.botAccountId === id);
      if (!bot) throw new Error(`unexpected account ${id}`);
      return { accountId: overrides.botId ?? id, kind: 'bot', parentAccountId: overrides.botParent ?? bot.projectAccountId };
    },
    async getApplication(id) {
      const spec = specs.find((candidate) => candidate.bindingApplicationId === id);
      if (!spec) throw new Error(`unexpected app ${id}`);
      return {
        applicationId: overrides.applicationId ?? id,
        ownerAccountId: overrides.applicationOwner ?? spec.projectAccountId,
        status: 'active',
      };
    },
  };
}

async function authority() {
  return verifyNativeProductAgentAuthority(
    reader(),
    NATIVE_PRODUCT_AGENT_IDENTITY.oxyOrganizationId,
    specs,
  );
}

function stored(spec: (typeof specs)[number]): NativeProductAgentStoredState {
  return {
    ...spec.row,
    tags: [...spec.row.tags],
    capabilityGrants: [...spec.row.capabilityGrants],
  };
}

describe('native product agent manifest', () => {
  it('pins exact primary keys, private bindings, grants and source prompt hashes', () => {
    expect(nativeProductAgentHandoffManifest()).toEqual({
      schemaVersion: 1,
      oxyOrganizationId: '69b2d3df5d12f58c9800d651',
      agents: [
        expect.objectContaining({
          id: '01a0646a-078f-7514-9800-9f43ceed7df8',
          oxyAccountId: '01a0646a-078f-7974-9645-a5e8be237f47',
          ownerOxyAccountId: '01a0646a-078f-72ea-8759-86326484a7e0',
          applicationId: '6a2f851751b784a86fd0e922',
          routingProfileId: '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
          visibility: 'private',
          capabilityGrants: ['web'],
          systemPrompt: expect.objectContaining({ sha256: 'e343b294c14ca519f8edb66552d00eb11c9386f2ec42b41ea1ff145cb6e958e0' }),
        }),
        expect.objectContaining({
          id: '01a0646a-078f-7642-95ef-439952f4f3f9',
          oxyAccountId: '01a0646a-078f-7120-a993-a03c180c81b0',
          ownerOxyAccountId: '01a0646a-078f-7f53-848d-a0f82d9f7fa6',
          applicationId: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
          routingProfileId: '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
          visibility: 'private',
          capabilityGrants: ['web', 'artifacts', 'memory'],
          systemPrompt: expect.objectContaining({ sha256: 'e261b272d30a2f99f14de50c2c7fd9fc4990e7df5b1db20c2f3d7ceaf8647f09' }),
        }),
      ],
    });
  });

  it.each([
    ['wrong project parent', { projectParent: 'wrong' }],
    ['wrong bot parent', { botParent: 'wrong' }],
    ['wrong application owner', { applicationOwner: 'wrong' }],
    ['wrong application id', { applicationId: 'wrong' }],
  ])('fails closed on %s', async (_label, override) => {
    await expect(
      verifyNativeProductAgentAuthority(
        reader(override),
        NATIVE_PRODUCT_AGENT_IDENTITY.oxyOrganizationId,
        specs,
      ),
    ).rejects.toThrow(/mismatch/);
  });

  it.each([
    ['organization id leading whitespace', { organizationId: ` ${NATIVE_PRODUCT_AGENT_IDENTITY.oxyOrganizationId}` }],
    ['organization id trailing whitespace', { organizationId: `${NATIVE_PRODUCT_AGENT_IDENTITY.oxyOrganizationId} ` }],
    ['project id leading whitespace', { projectId: ` ${specs[0]!.projectAccountId}` }],
    ['project id trailing whitespace', { projectId: `${specs[0]!.projectAccountId} ` }],
    ['bot id leading whitespace', { botId: ` ${specs[0]!.botAccountId}` }],
    ['bot id trailing whitespace', { botId: `${specs[0]!.botAccountId} ` }],
    ['application id leading whitespace', { applicationId: ` ${specs[0]!.bindingApplicationId}` }],
    ['application id trailing whitespace', { applicationId: `${specs[0]!.bindingApplicationId} ` }],
  ])('rejects %s instead of normalizing identity', async (_label, override) => {
    await expect(
      verifyNativeProductAgentAuthority(
        reader(override),
        NATIVE_PRODUCT_AGENT_IDENTITY.oxyOrganizationId,
        specs,
      ),
    ).rejects.toThrow(/mismatch/);
  });

  it('recognizes reserved agent primary keys byte-for-byte only', () => {
    const id = specs[0]!.agentId;
    expect(isNativeProductAgentId(id)).toBe(true);
    expect(isNativeProductAgentId(` ${id}`)).toBe(false);
    expect(isNativeProductAgentId(`${id} `)).toBe(false);
  });
});

describe('native product agent plan', () => {
  it('hashes the full prompt, grants and application binding', async () => {
    const plan = buildNativeProductAgentPlan({
      direction: 'apply',
      specs,
      authority: await authority(),
      observed: [],
      desiredManifest: nativeProductAgentHandoffManifest(),
    });
    const promptDrift = structuredClone(plan);
    promptDrift.after[0]!.systemPrompt += '\nchanged';
    const grantDrift = structuredClone(plan);
    grantDrift.after[1]!.capabilityGrants = ['web'];
    const bindingDrift = structuredClone(plan);
    bindingDrift.after[0]!.applicationId = 'wrong';
    const routingDrift = structuredClone(plan);
    routingDrift.after[0]!.routingProfileId = 'wrong';

    expect(nativeProductAgentPlanSha256(promptDrift)).not.toBe(nativeProductAgentPlanSha256(plan));
    expect(nativeProductAgentPlanSha256(grantDrift)).not.toBe(nativeProductAgentPlanSha256(plan));
    expect(nativeProductAgentPlanSha256(bindingDrift)).not.toBe(nativeProductAgentPlanSha256(plan));
    expect(nativeProductAgentPlanSha256(routingDrift)).not.toBe(nativeProductAgentPlanSha256(plan));
  });

  it('refuses bot and reserved-PK collisions instead of rebinding them', async () => {
    const first = stored(specs[0]);
    await expect(async () => buildNativeProductAgentPlan({
      direction: 'apply',
      specs,
      authority: await authority(),
      observed: [{ ...first, id: 'some-other-agent' }],
      desiredManifest: nativeProductAgentHandoffManifest(),
    })).rejects.toThrow(/bot account collision/);

    await expect(async () => buildNativeProductAgentPlan({
      direction: 'apply',
      specs,
      authority: await authority(),
      observed: [{ ...first, oxyAccountId: 'some-other-bot' }],
      desiredManifest: nativeProductAgentHandoffManifest(),
    })).rejects.toThrow(/already bound to bot/);
  });

  it('rolls back by making rows inactive/private and clearing bindings, never deleting them', async () => {
    const observed = specs.map(stored);
    const plan = buildNativeProductAgentPlan({
      direction: 'rollback',
      specs,
      authority: await authority(),
      observed,
      desiredManifest: nativeProductAgentHandoffManifest(),
    });

    expect(plan.after).toHaveLength(2);
    expect(plan.after.every((row) => row?.status === 'offline')).toBe(true);
    expect(plan.after.every((row) => row?.access === 'private')).toBe(true);
    expect(plan.after.every((row) => row?.isPublished === false)).toBe(true);
    expect(plan.after.every((row) => row?.applicationId === null)).toBe(true);
    expect(plan.operations.join('\n')).not.toMatch(/delete/i);
  });
});

describe('bootstrap Oxy token destination', () => {
  it('allows mutation only against the exact canonical HTTPS origin', () => {
    expect(assertOxyBootstrapOrigin('https://api.oxy.so', { mutate: true, allowLoopback: false }))
      .toBe('https://api.oxy.so');
    for (const hostile of [
      'http://api.oxy.so',
      'https://api.oxy.so.evil.test',
      'https://api.oxy.so@evil.test',
      'https://api.oxy.so/path',
      'https://api.oxy.so?redirect=https://evil.test',
      'https://api.oxy.so#evil',
      'https://api.oxy.so/',
      'http://127.0.0.1:3000',
    ]) {
      expect(() => assertOxyBootstrapOrigin(hostile, { mutate: true, allowLoopback: true }))
        .toThrow(/requires OXY_API_URL/);
    }
  });

  it('requires an explicit opt-in for a plain loopback dry-run origin', () => {
    expect(() => assertOxyBootstrapOrigin('http://127.0.0.1:3000', {
      mutate: false,
      allowLoopback: false,
    })).toThrow(/explicitly allowed loopback/);
    expect(assertOxyBootstrapOrigin('http://127.0.0.1:3000', {
      mutate: false,
      allowLoopback: true,
    })).toBe('http://127.0.0.1:3000');
    expect(() => assertOxyBootstrapOrigin('http://user:token@127.0.0.1:3000', {
      mutate: false,
      allowLoopback: true,
    })).toThrow(/explicitly allowed loopback/);
  });
});
