import { ChatPageContent } from '@/components/chat-page-content';
import { WelcomeIntro } from '@/components/welcome-intro';
import { resolveSelection, useCatalogue } from '@/lib/hooks/use-catalogue';
import { useChatConversation } from '@/lib/hooks/use-chat-conversation';
import { useProductModes } from '@/lib/hooks/use-product-modes';
import { useStore } from '@/lib/stores/global-store';
import { useModelStore } from '@/lib/stores/model-store';
import { useAuth } from '@oxy.so/services';
import Head from 'expo-router/head';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

/** The chat rises into view as the intro leaves: 600ms, 450ms after it starts. */
const CHAT_RISE_DURATION = 600;
const CHAT_RISE_DELAY = 450;
const CHAT_RISE_EASE = Easing.bezier(0.16, 0.84, 0.28, 1);
const CHAT_RISE_DISTANCE = 22;

const ChatPage = () => {
  // The store holds what the user chose; the catalogue decides what a request
  // may carry. They differ only when the chosen identifier is no longer one the
  // product offers, and sending that identifier would be a 400.
  const selectedModel = useModelStore((s) => s.selectedModel);
  const setSelectedModel = useModelStore((s) => s.setSelectedModel);
  /**
   * The effort level, on the FIRST turn too.
   *
   * This screen passed no reasoning setting at all — not the level, and not the
   * `thinkingMode` boolean before it — so a person who chose an effort and then
   * typed their first message got a turn that carried none of it, and only the
   * second message onwards honoured the choice. The conversation screen
   * (`c/[id]/index.tsx`) always passed it, which is why the gap read as
   * "sometimes it works".
   */
  const reasoningEffort = useModelStore((s) => s.reasoningEffort);
  const { data: catalogue } = useCatalogue();
  const { data: modes } = useProductModes();
  const selection = resolveSelection(
    selectedModel,
    catalogue,
    undefined,
    modes,
  );

  const ghostMode = useStore((state) => state.ghostMode);

  const { isAuthenticated, isAuthResolved } = useAuth();

  /**
   * Signed out means the intro, every time — not only on a first visit.
   *
   * It used to latch on a persisted `welcomeSeen`, so somebody who had once
   * dismissed it landed on a chat panel with no explanation of what this is.
   * Whether a person has met Alia is not a fact about their browser's storage;
   * it is whether they have an account. So the account is the whole gate, and
   * the flag it used to read — along with the hydration wait that existed only
   * to read it safely — is gone.
   *
   * Still gated on `isAuthResolved` so a cold-boot reload with a live session
   * never flashes it. Once showing it is latched by `introState`: the intro
   * signs the user in while its exit is still playing, and letting
   * `isAuthenticated` flip the gate mid-animation would tear it off the screen.
   */
  const [introState, setIntroState] = useState<'idle' | 'showing' | 'done'>(
    'idle',
  );
  if (introState === 'idle' && isAuthResolved && !isAuthenticated) {
    setIntroState('showing');
  }
  const introShown = introState !== 'idle';
  const chatRise = useSharedValue(0);
  const chatStyle = useAnimatedStyle(() => ({
    opacity: introShown ? chatRise.value : 1,
    transform: [
      {
        translateY: introShown ? (1 - chatRise.value) * CHAT_RISE_DISTANCE : 0,
      },
    ],
  }));
  const handleIntroExitStart = useCallback(() => {
    chatRise.value = withDelay(
      CHAT_RISE_DELAY,
      withTiming(1, { duration: CHAT_RISE_DURATION, easing: CHAT_RISE_EASE }),
    );
  }, [chatRise]);
  const handleIntroDismissed = useCallback(() => setIntroState('done'), []);

  /**
   * The whole of the hook, because the whole of it applies here.
   *
   * This screen used to take seven of these and leave the rest on the floor,
   * which read as "the first turn is a lesser turn": it could not be stopped
   * once it started, a failure left no card and no way to retry, a plan asked
   * for approval nobody could give, and the offer of a fresh thread had no
   * answer. In ghost mode that is not the first turn of anything — nothing is
   * ever persisted, so the ENTIRE conversation happens on this screen with
   * those capabilities missing. `conversation-screen.tsx` is the reference for
   * what a chat can do; the only honest difference here is that there is no
   * conversation id yet.
   */
  const {
    messages,
    isLoading,
    conversationLoading,
    sendMessage,
    createNewConversation,
    stopGeneration,
    clearConversation,
    approvePlan,
    rejectPlan,
    suggestedNewConversation,
    dismissSuggestedNewConversation,
    failedTurn,
    retryFailedTurn,
  } = useChatConversation({
    reasoningEffort,
    selectedModel: selection.effectiveId ?? undefined,
  });

  const handleSubmit = ghostMode ? sendMessage : createNewConversation;

  /**
   * Taking the agent up on its offer of a fresh start, on the screen where a
   * fresh start is the cheapest thing there is.
   *
   * On `conversation-screen.tsx` accepting means creating the NEXT stretch of
   * an agent's thread — a persisted conversation, a handle to re-read. None of
   * that applies here: this screen is already the empty one, and nothing has
   * been written yet in ghost mode by design. So accepting stops whatever is
   * streaming and empties the thread, which is genuinely "start a new
   * conversation" on a screen that has no id.
   *
   * It is not simply `dismiss`. The card's primary button says the offer will
   * be acted on, and a button that only retires the card it sits in would be a
   * control with nothing behind it — the offer already has a second button for
   * that.
   */
  const handleAcceptNewConversation = useCallback(() => {
    dismissSuggestedNewConversation();
    void clearConversation();
  }, [dismissSuggestedNewConversation, clearConversation]);

  return (
    <>
      <>
        <Head>
          <title>Alia \ Oxy</title>
          <meta
            name="description"
            content="Meet Alia, your intelligent AI assistant. Chat naturally, remember everything, and switch between the best AI models seamlessly."
          />
          <link rel="canonical" href="https://alia.onl/" />
          <meta property="og:title" content="Alia \ Oxy" />
          <meta
            property="og:description"
            content="Meet Alia, your intelligent AI assistant. Chat naturally, remember everything, and switch between the best AI models seamlessly."
          />
          <meta
            property="og:image"
            content="https://alia.onl/og-image-default.png"
          />
        </Head>
        <Animated.View style={[{ flex: 1 }, chatStyle]}>
          <ChatPageContent
            // No `conversationId`, deliberately: this is the new-chat screen,
            // and its absence is what `ChatPageContent` reads to decide which
            // mounted instance a `composerDraft` belongs to. The drawer keeps
            // every visited chat alive, so naming an id here would hand this
            // screen's draft to a persisted conversation.
            messages={messages}
            isLoading={isLoading}
            conversationLoading={conversationLoading}
            onSubmit={handleSubmit}
            onStop={stopGeneration}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            onApprovePlan={approvePlan}
            onRejectPlan={rejectPlan}
            suggestedNewConversation={suggestedNewConversation}
            onAcceptNewConversation={handleAcceptNewConversation}
            onDismissNewConversation={dismissSuggestedNewConversation}
            failedTurn={failedTurn}
            onRetryTurn={retryFailedTurn}
          />
        </Animated.View>

        {introState === 'showing' ? (
          <View
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              zIndex: 20,
            }}
          >
            <WelcomeIntro
              onExitStart={handleIntroExitStart}
              onDismissed={handleIntroDismissed}
            />
          </View>
        ) : null}
      </>
    </>
  );
};

export default ChatPage;
