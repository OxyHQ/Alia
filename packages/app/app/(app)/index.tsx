import { useState, useEffect, useCallback } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Head from "expo-router/head";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { useAuth } from "@oxyhq/services";
import { WelcomeIntro } from "@/components/welcome-intro";
import { useStore } from "@/lib/stores/global-store";
import { useModelStore } from "@/lib/stores/model-store";
import { resolveSelection, useCatalogue } from "@/lib/hooks/use-catalogue";
import { useChatConversation } from "@/lib/hooks/use-chat-conversation";
import { useCreateConversation } from "@/lib/hooks/use-conversations";
import { ChatPageContent } from "@/components/chat-page-content";
import { toast } from "@oxyhq/bloom/toast";
import { ContentPanel } from "@oxyhq/bloom/content-panel";

/** The chat rises into view as the intro leaves: 600ms, 450ms after it starts. */
const CHAT_RISE_DURATION = 600;
const CHAT_RISE_DELAY = 450;
const CHAT_RISE_EASE = Easing.bezier(0.16, 0.84, 0.28, 1);
const CHAT_RISE_DISTANCE = 22;

const ChatPage = () => {
  const router = useRouter();
  const createConversationMutation = useCreateConversation();

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
  const selection = resolveSelection(selectedModel, catalogue);

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
  const [introState, setIntroState] = useState<"idle" | "showing" | "done">("idle");
  if (introState === "idle" && isAuthResolved && !isAuthenticated) {
    setIntroState("showing");
  }
  const introShown = introState !== "idle";
  const chatRise = useSharedValue(0);
  const chatStyle = useAnimatedStyle(() => ({
    opacity: introShown ? chatRise.value : 1,
    transform: [{ translateY: introShown ? (1 - chatRise.value) * CHAT_RISE_DISTANCE : 0 }],
  }));
  const handleIntroExitStart = useCallback(() => {
    chatRise.value = withDelay(
      CHAT_RISE_DELAY,
      withTiming(1, { duration: CHAT_RISE_DURATION, easing: CHAT_RISE_EASE }),
    );
  }, [chatRise]);
  const handleIntroDismissed = useCallback(() => setIntroState("done"), []);

  const {
    messages,
    isLoading,
    scrollViewRef,
    sendMessage,
    createNewConversation,
    editMessage,
    clearConversation,
  } = useChatConversation({ reasoningEffort, selectedModel: selection.effectiveId ?? undefined });

  const handleSubmit = ghostMode ? sendMessage : createNewConversation;

  const handleVoiceStart = useCallback(async () => {
    try {
      const conv = await createConversationMutation.mutateAsync({});
      router.replace({ pathname: "/(app)/c/[id]", params: { id: conv.id, startVoice: "true" } });
    } catch {
      toast.error("Failed to start voice session");
    }
  }, [createConversationMutation, router]);

  return (
    <ContentPanel surfaceClassName="bg-background">
      <>
        <Head>
          <title>Alia \ Oxy</title>
          <meta name="description" content="Meet Alia, your intelligent AI assistant. Chat naturally, remember everything, and switch between the best AI models seamlessly." />
          <link rel="canonical" href="https://alia.onl/" />
          <meta property="og:title" content="Alia \ Oxy" />
          <meta property="og:description" content="Meet Alia, your intelligent AI assistant. Chat naturally, remember everything, and switch between the best AI models seamlessly." />
          <meta property="og:image" content="https://alia.onl/og-image-default.png" />
        </Head>
        <Animated.View style={[{ flex: 1 }, chatStyle]}>
          <ChatPageContent
            messages={messages}
            scrollViewRef={scrollViewRef}
            isLoading={isLoading}
            onSubmit={handleSubmit}
            onEditMessage={editMessage}
            onClear={clearConversation}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            onVoiceStart={handleVoiceStart}
          />
        </Animated.View>

        {introState === "showing" ? (
          <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 20 }}>
            <WelcomeIntro
              onExitStart={handleIntroExitStart}
              onDismissed={handleIntroDismissed}
            />
          </View>
        ) : null}
      </>
    </ContentPanel>
  );
};

export default ChatPage;
