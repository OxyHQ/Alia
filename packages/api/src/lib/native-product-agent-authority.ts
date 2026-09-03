import { OxyServices } from '@oxyhq/core';
import type { LoadedNativeProductAgentSpec } from '../config/native-product-agents.js';

export interface OxyAuthorityAccount {
  accountId: string;
  kind: string;
  parentAccountId: string | null;
}

export interface OxyAuthorityApplication {
  applicationId: string;
  ownerAccountId: string;
  status: string;
}

export interface OxyNativeProductAuthorityReader {
  getAccount(id: string): Promise<OxyAuthorityAccount>;
  getApplication(id: string): Promise<OxyAuthorityApplication>;
}

export interface NativeProductAuthoritySnapshot {
  oxyOrganization: OxyAuthorityAccount;
  agents: Array<{
    agentId: string;
    project: OxyAuthorityAccount;
    bot: OxyAuthorityAccount;
    application: OxyAuthorityApplication;
  }>;
}

function exact(label: string, observed: string | null, expected: string | null): void {
  if (observed !== expected) {
    throw new Error(`${label} mismatch: expected ${String(expected)}, observed ${String(observed)}`);
  }
}

export async function verifyNativeProductAgentAuthority(
  reader: OxyNativeProductAuthorityReader,
  oxyOrganizationId: string,
  specs: readonly LoadedNativeProductAgentSpec[],
): Promise<NativeProductAuthoritySnapshot> {
  const organization = await reader.getAccount(oxyOrganizationId);
  exact('Oxy organization id', organization.accountId, oxyOrganizationId);
  exact('Oxy organization kind', organization.kind, 'organization');

  const verified = [];
  for (const spec of specs) {
    const [project, bot, application] = await Promise.all([
      reader.getAccount(spec.projectAccountId),
      reader.getAccount(spec.botAccountId),
      reader.getApplication(spec.bindingApplicationId),
    ]);
    exact(`${spec.key} project id`, project.accountId, spec.projectAccountId);
    exact(`${spec.key} project kind`, project.kind, 'project');
    exact(`${spec.key} project parent`, project.parentAccountId, oxyOrganizationId);
    exact(`${spec.key} bot id`, bot.accountId, spec.botAccountId);
    exact(`${spec.key} bot kind`, bot.kind, 'bot');
    exact(`${spec.key} bot parent`, bot.parentAccountId, spec.projectAccountId);
    exact(`${spec.key} application id`, application.applicationId, spec.bindingApplicationId);
    exact(`${spec.key} application owner`, application.ownerAccountId, spec.projectAccountId);
    exact(`${spec.key} application status`, application.status, 'active');
    verified.push({ agentId: spec.agentId, project, bot, application });
  }
  return { oxyOrganization: organization, agents: verified };
}

/** Exact Oxy read surface. It never queries Oxy's database and performs no writes. */
export function oxyAuthorityReader(baseURL: string, accessToken: string): OxyNativeProductAuthorityReader {
  const oxy = new OxyServices({ baseURL });
  oxy.setTokens(accessToken);
  return {
    async getAccount(id) {
      const node = await oxy.getAccount(id);
      return { accountId: node.accountId, kind: node.kind, parentAccountId: node.parentAccountId };
    },
    async getApplication(id) {
      const app = await oxy.getApp(id);
      return { applicationId: app._id, ownerAccountId: app.ownerAccountId, status: app.status };
    },
  };
}
