/**
 * "Ask Alia", "Ask Sindi": one sheet an app mounts once, opened on any agent from anywhere in it.
 *
 * The app names the agents it offers (`agents`, by a key of its own) and configures the sheet
 * once — its host tools, renderers, words, voice, context, upsell and share. A button calls
 * `useAskAgent().ask(key, turn)`. Signed out, the sheet is not mounted (it could not call Alia):
 * `ask` opens Oxy's sign-in instead, and the person asks again once signed in.
 */

import { useAuth } from '@oxy.so/services/ui/client';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AliaTurn } from '../hooks/useChatComposer';
import { AliaChatSheet, type AliaChatSheetProps, type AliaChatSheetRef } from './AliaChatSheet';

/** The agents an app offers, by its own key. An entry without `id` is Alia. */
export type AliaAskAgents = Readonly<Record<string, { id?: string }>>;

export interface AliaAskProviderProps
  extends Pick<
    AliaChatSheetProps,
    | 'hostTools'
    | 'toolRenderers'
    | 'labels'
    | 'voice'
    | 'clientContext'
    | 'onFeatureLocked'
    | 'onShare'
    | 'model'
    | 'apiUrl'
    | 'characterRuntimeUrl'
    | 'headerMenu'
  > {
  /** The agents `ask` opens, by key. Omitted, the sheet only ever opens on Alia. */
  agents?: AliaAskAgents;
  /** The lines offered over Alia's empty composer; an agent offers its own starters. */
  welcomeSuggestions?: AliaChatSheetProps['welcomeSuggestions'];
  children: ReactNode;
}

export interface AliaAsk {
  /**
   * Open the sheet on the agent `agentKey` (omitted, Alia), with `turn` already sent when given
   * ("ask Sindi about this listing"). Signed out, opens Oxy's sign-in instead.
   */
  ask: (agentKey?: string, turn?: AliaTurn) => void;
}

const AskContext = createContext<AliaAsk | null>(null);

/** The app's way to open its one Alia sheet. Must be used under `AliaAskProvider`. */
export function useAskAgent(): AliaAsk {
  const ask = useContext(AskContext);
  if (ask === null) throw new Error('useAskAgent must be used within an AliaAskProvider');
  return ask;
}

/** Which agent the sheet is on, and the opening that waits for that sheet to mount. */
interface Opening {
  key: string | undefined;
  turn: AliaTurn | undefined;
  /** Changes on every `ask`, so asking the same agent twice opens twice. */
  serial: number;
}

export function AliaAskProvider({
  agents,
  welcomeSuggestions,
  children,
  ...sheet
}: AliaAskProviderProps) {
  const { canUsePrivateApi, signIn } = useAuth();
  const sheetRef = useRef<AliaChatSheetRef>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const ask = useCallback(
    (agentKey?: string, turn?: AliaTurn) => {
      if (agentKey !== undefined && agentsRef.current?.[agentKey] === undefined) {
        throw new Error(`AliaAskProvider has no agent "${agentKey}"`);
      }
      if (!canUsePrivateApi) {
        void signIn().catch(() => undefined);
        return;
      }
      setCurrent(agentKey);
      setOpening((previous) => ({ key: agentKey, turn, serial: (previous?.serial ?? 0) + 1 }));
    },
    [canUsePrivateApi, signIn],
  );

  // Presented once the sheet for that agent is the one mounted (a different agent is a new sheet).
  useEffect(() => {
    if (opening === null || opening.key !== current) return;
    sheetRef.current?.present(opening.turn);
    setOpening(null);
  }, [opening, current]);

  const agentId = current === undefined ? undefined : agents?.[current]?.id;
  const agent = useMemo(() => (agentId === undefined ? undefined : { id: agentId }), [agentId]);
  const value = useMemo<AliaAsk>(() => ({ ask }), [ask]);

  return (
    <AskContext.Provider value={value}>
      {children}
      {canUsePrivateApi ? (
        <AliaChatSheet
          key={agentId ?? 'alia'}
          ref={sheetRef}
          {...sheet}
          agent={agent}
          welcomeSuggestions={agent === undefined ? welcomeSuggestions : undefined}
        />
      ) : null}
    </AskContext.Provider>
  );
}
