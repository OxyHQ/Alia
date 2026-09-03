import Conf from 'conf';

export interface Session {
  id: string;
  title: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>;
  createdAt: number;
  updatedAt: number;
  cwd: string;
}

interface ConfigSchema {
  /**
   * A credential previous versions stored here, kept in the schema for ONE
   * reason: so `signOut` can erase it.
   *
   * It is never read. Versions before the Oxy device-flow migration wrote an
   * `alia_sk_*` developer key into this file, which is world-readable and shared
   * with ordinary preferences. Alia stopped issuing those in #160 and nothing
   * accepts one from here any more — but dropping the field silently would
   * leave the secret sitting on every existing user's disk forever, because
   * `Conf` only rewrites keys it knows about. Declaring it is what lets it be
   * deleted.
   *
   * The NAME must stay `apiKey`, because that is the key already written on
   * disk — renaming it to something tidier would delete a key nobody has and
   * leave the real credential in place.
   */
  apiKey?: string;
  apiBaseUrl: string;
  defaultModel: string;
  sessions: Session[];
  currentSessionId: string | null;
}

export const config = new Conf<ConfigSchema>({
  projectName: 'alia-codea-cli',
  defaults: {
    apiBaseUrl: 'https://api.alia.onl',
    defaultModel: 'kaana-v1-codea',
    sessions: [],
    currentSessionId: null,
  },
});

export function saveSession(session: Session): void {
  const sessions = config.get('sessions') || [];
  const existingIndex = sessions.findIndex(s => s.id === session.id);

  if (existingIndex >= 0) {
    sessions[existingIndex] = session;
  } else {
    sessions.unshift(session);
  }

  // Keep only last 50 sessions
  if (sessions.length > 50) {
    sessions.splice(50);
  }

  config.set('sessions', sessions);
}

export function getSession(id: string): Session | undefined {
  const sessions = config.get('sessions') || [];
  return sessions.find(s => s.id === id);
}

export function getSessions(): Session[] {
  return config.get('sessions') || [];
}

export function createSession(): Session {
  const session: Session = {
    id: Date.now().toString(),
    title: 'New conversation',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cwd: process.cwd(),
  };
  saveSession(session);
  config.set('currentSessionId', session.id);
  return session;
}
