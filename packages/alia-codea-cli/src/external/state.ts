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
  /** `<agentId>:<conversation>` -> the CLI's own session id, so a conversation continues it. */
  sessions: Record<string, string>;
}

const MAX_SESSIONS = 300;

export interface SessionStore {
  get(key: string): string | undefined;
  set(key: string, sessionId: string): void;
  delete(key: string): void;
}

/** Which agents this machine serves. Not a secret: the Oxy session is stored elsewhere. */
const store = new Conf<Schema>({
  projectName: 'alia-codea-cli',
  configName: 'external-agents',
  defaults: { agents: [], sessions: {} },
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

/** Persisted, so a conversation survives a restart of the daemon. Bounded: the oldest are dropped. */
export function sessionStore(): SessionStore {
  return {
    get: (key) => store.get('sessions')[key],
    set(key, sessionId) {
      const { [key]: _old, ...rest } = store.get('sessions');
      const entries = Object.entries({ ...rest, [key]: sessionId });
      store.set('sessions', Object.fromEntries(entries.slice(-MAX_SESSIONS)));
    },
    delete(key) {
      const { [key]: _gone, ...rest } = store.get('sessions');
      store.set('sessions', rest);
    },
  };
}
