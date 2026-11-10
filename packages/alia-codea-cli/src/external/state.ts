import Conf from 'conf';
import type { ExternalCli } from './types.js';

export interface PairedAgent {
  readonly agentId: string;
  readonly name: string;
  readonly cli: ExternalCli;
  /** Where this machine pairs from; a different Alia is a different agent. */
  readonly apiBaseUrl: string;
}

interface Schema {
  agents: PairedAgent[];
}

/** Which agents this machine serves. Not a secret: the Oxy session is stored elsewhere. */
const store = new Conf<Schema>({
  projectName: 'alia-codea-cli',
  configName: 'external-agents',
  defaults: { agents: [] },
});

export function pairedAgents(apiBaseUrl: string): PairedAgent[] {
  return store.get('agents').filter((agent) => agent.apiBaseUrl === apiBaseUrl);
}

export function rememberAgent(agent: PairedAgent): void {
  const others = store.get('agents').filter((a) => a.agentId !== agent.agentId);
  store.set('agents', [...others, agent]);
}

export function forgetAgent(agentId: string): void {
  store.set(
    'agents',
    store.get('agents').filter((a) => a.agentId !== agentId),
  );
}
