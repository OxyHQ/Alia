import Conf from 'conf';

interface Session {
  id: string;
  title: string;
  messages: Array<{ role: string; content: string }>;
  createdAt: number;
  updatedAt: number;
  cwd: string;
}

interface ConfigSchema {
  apiKey: string;
  apiBaseUrl: string;
  defaultModel: string;
  sessions: Session[];
  currentSessionId: string | null;
}

export const config = new Conf<ConfigSchema>({
  projectName: 'codea-cli',
  defaults: {
    apiKey: '',
    apiBaseUrl: 'https://api.alia.onl',
    defaultModel: 'alia-v1-codea',
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
