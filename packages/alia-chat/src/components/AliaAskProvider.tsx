/**
 * "Ask Alia", "Ask Sindi": one sheet an app mounts once, opened on any agent from anywhere in it.
 *
 * The app names the agents it offers (`agents`, by a key of its own) and configures the sheet
 * once — its host tools, renderers, words, voice, context, upsell and share. A button calls
 * `useAskAgent().ask(key, turn)`. Signed out, the sheet is not mounted (it could not call Alia):
 * `ask` opens Oxy's sign-in instead, and the person asks again once signed in.
 *
 * The sheet itself (`AliaAskSheet`) is loaded lazily and mounted on the first `ask`, so an app
 * that mounts this provider at its root — imported from `@alia.onl/sdk/ask` — keeps the chat out
 * of its entry bundle. Signed in, its module is fetched in the background so the first `ask`
 * does not wait on the network.
 */

import { useAuth } from '@oxy.so/services/ui/client';
import {
  createContext,
  forwardRef,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AliaTurn } from '../hooks/useChatComposer';
import type { AliaChatSheetProps, AliaChatSheetRef } from './AliaChatSheet';
import type { AliaAskOpening } from './AliaAskSheet';

const loadSheet = () => import('./AliaAskSheet');
const LazyAskSheet = lazy(() => loadSheet().then((module) => ({ default: module.AliaAskSheet })));

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
    | 'recentConversations'
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
  /** Open the sheet on the agent `agentKey` (omitted, Alia), on its stored conversation `conversationId`. */
  resume: (agentKey: string | undefined, conversationId: string) => void;
  /**
   * Close the sheet — a host tool that changed the page under it shows the person the result, once
   * the turn has been written.
   */
  dismiss: () => void;
}

const AskContext = createContext<AliaAsk | null>(null);

/** The app's way to open its one Alia sheet. Must be used under `AliaAskProvider`. */
export function useAskAgent(): AliaAsk {
  const ask = useContext(AskContext);
  if (ask === null) throw new Error('useAskAgent must be used within an AliaAskProvider');
  return ask;
}

/** The opening that waits for the sheet of agent `key` to be the one mounted. */
interface Opening extends AliaAskOpening {
  key: string | undefined;
}

/**
 * Mounts the app's one sheet. Its ref is the same `AliaAsk` as `useAskAgent()`, for the code that
 * configures the sheet and so sits above it — a host-tool executor that closes it.
 */
export const AliaAskProvider = forwardRef<AliaAsk, AliaAskProviderProps>(function AliaAskProvider(
  { agents, welcomeSuggestions, children, ...sheet },
  ref,
) {
  const { canUsePrivateApi, signIn } = useAuth();
  const sheetRef = useRef<AliaChatSheetRef>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  /** Nothing is mounted before the first `ask`. */
  const [asked, setAsked] = useState(false);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const open = useCallback(
    (agentKey: string | undefined, turn?: AliaTurn, conversationId?: string) => {
      if (agentKey !== undefined && agentsRef.current?.[agentKey] === undefined) {
        throw new Error(`AliaAskProvider has no agent "${agentKey}"`);
      }
      if (!canUsePrivateApi) {
        void signIn().catch(() => undefined);
        return;
      }
      setAsked(true);
      setCurrent(agentKey);
      setOpening((previous) => ({
        key: agentKey,
        turn,
        ...(conversationId === undefined ? {} : { conversationId }),
        serial: (previous?.serial ?? 0) + 1,
      }));
    },
    [canUsePrivateApi, signIn],
  );
  const ask = useCallback((agentKey?: string, turn?: AliaTurn) => open(agentKey, turn), [open]);
  const resume = useCallback(
    (agentKey: string | undefined, conversationId: string) =>
      open(agentKey, undefined, conversationId),
    [open],
  );
  const dismiss = useCallback(() => sheetRef.current?.dismiss(), []);

  const opened = useCallback(() => setOpening(null), []);

  // Signed in, the sheet's module comes down in the background, ahead of the first `ask`.
  useEffect(() => {
    if (canUsePrivateApi) void loadSheet().catch(() => undefined);
  }, [canUsePrivateApi]);

  const agentId = current === undefined ? undefined : agents?.[current]?.id;
  const agent = useMemo(() => (agentId === undefined ? undefined : { id: agentId }), [agentId]);
  const value = useMemo<AliaAsk>(() => ({ ask, resume, dismiss }), [ask, resume, dismiss]);
  useImperativeHandle(ref, () => value, [value]);

  return (
    <AskContext.Provider value={value}>
      {children}
      {canUsePrivateApi && asked ? (
        <Suspense fallback={null}>
          <LazyAskSheet
            key={agentId ?? 'alia'}
            ref={sheetRef}
            {...sheet}
            agent={agent}
            welcomeSuggestions={agent === undefined ? welcomeSuggestions : undefined}
            // A different agent is a new sheet: the opening waits for that one to mount.
            opening={opening !== null && opening.key === current ? opening : null}
            onOpened={opened}
          />
        </Suspense>
      ) : null}
    </AskContext.Provider>
  );
});
