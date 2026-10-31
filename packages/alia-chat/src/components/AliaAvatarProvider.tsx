import { AgentAvatarProvider } from '@oxy.so/bloom/agent-avatar';
import { createContext, type ReactNode, useContext } from 'react';
import { ALIA_CHARACTER_RUNTIME_URL } from '../lib/character-runtime';

const RuntimeUrl = createContext<string | undefined>(undefined);
/** Icons inside a chat inherit its explicit host URL instead of replacing it. */
export function AliaAvatarProvider({
  runtimeUrl,
  children,
}: {
  runtimeUrl?: string;
  children: ReactNode;
}) {
  const inherited = useContext(RuntimeUrl);
  const resolved = runtimeUrl ?? inherited ?? ALIA_CHARACTER_RUNTIME_URL;
  return (
    <RuntimeUrl.Provider value={resolved}>
      <AgentAvatarProvider runtimeUrl={resolved}>{children}</AgentAvatarProvider>
    </RuntimeUrl.Provider>
  );
}
