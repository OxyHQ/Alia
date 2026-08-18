import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
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
import { useRolesStore } from "@/lib/stores/roles-store";
import { useUIStore } from "@/lib/stores/ui-store";
import { useStore } from "@/lib/stores/global-store";
import { useModelStore } from "@/lib/stores/model-store";
import { resolveSelection, useCatalogue } from "@/lib/hooks/use-catalogue";
import { useChatConversation } from "@/lib/hooks/use-chat-conversation";
import { useCreateConversation } from "@/lib/hooks/use-conversations";
import { ChatPageContent } from "@/components/chat-page-content";
import { toast } from "@oxyhq/bloom/toast";
import { ContentPanel } from "@oxyhq/bloom/content-panel";

/**
 * `welcomeSeen` lives behind zustand's async `persist` rehydration, so reading
 * it before hydration finishes reports a false `false` and would bounce a
 * returning visitor back to the intro. Subscribing through
 * `useSyncExternalStore` is the only safe read of that external mutable flag —
 * a memoized read would go stale under the React Compiler.
 */
const subscribeToUIHydration = (onStoreChange: () => void) =>
  useUIStore.persist.onFinishHydration(onStoreChange);
const getUIHydrated = () => useUIStore.persist.hasHydrated();
const getUIHydratedOnServer = () => false;

/** The chat rises into view as the intro leaves: 600ms, 450ms after it starts. */
const CHAT_RISE_DURATION = 600;
const CHAT_RISE_DELAY = 450;
const CHAT_RISE_EASE = Easing.bezier(0.16, 0.84, 0.28, 1);
const CHAT_RISE_DISTANCE = 22;

const ChatPage = () => {
  const router = useRouter();
  const { roleId, skillId: skillIdParam } = useLocalSearchParams<{ roleId?: string; skillId?: string }>();
  const roles = useRolesStore((state) => state.roles);
  const activeSkillId = useStore((state) => state.activeSkillId);
  const createConversationMutation = useCreateConversation();

  const effectiveSkillId = skillIdParam || activeSkillId;

  useEffect(() => {
    if (skillIdParam && skillIdParam !== activeSkillId) {
      useStore.getState().setActiveSkillId(skillIdParam);
    }
  }, [skillIdParam, activeSkillId]);

  // The store holds what the user chose; the catalogue decides what a request
  // may carry. They differ only when the chosen identifier is no longer one the
  // product offers, and sending that identifier would be a 400.
  const selectedModel = useModelStore((s) => s.selectedModel);
  const setSelectedModel = useModelStore((s) => s.setSelectedModel);
  const { data: catalogue } = useCatalogue();
  const selection = resolveSelection(selectedModel, catalogue);
  const [activeRoleId, setActiveRoleId] = useState<string | undefined>(roleId);
  const activeRole = activeRoleId ? roles.find(r => r.id === activeRoleId) : undefined;

  const ghostMode = useStore((state) => state.ghostMode);

  const { isAuthenticated, isAuthResolved } = useAuth();
  const welcomeSeen = useUIStore((state) => state.welcomeSeen);
  const uiHydrated = useSyncExternalStore(
    subscribeToUIHydration,
    getUIHydrated,
    getUIHydratedOnServer,
  );

  // First run on this device: the intro takes over the panel without touching
  // the URL. Gated on `isAuthResolved` so a cold-boot reload with a live
  // session never flashes it, and on hydration so a past answer is never
  // missed. Once shown it is latched: the intro marks itself seen and signs the
  // user in while its exit is still playing, and either of those flipping the
  // gate mid-animation would tear it off the screen.
  const [introState, setIntroState] = useState<"idle" | "showing" | "done">("idle");
  if (
    introState === "idle" &&
    isAuthResolved &&
    !isAuthenticated &&
    uiHydrated &&
    !welcomeSeen
  ) {
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
  } = useChatConversation({ activeRole, selectedModel: selection.effectiveId, skillId: effectiveSkillId });

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
            activeRole={activeRole}
            onRemoveRole={() => setActiveRoleId(undefined)}
            onVoiceStart={handleVoiceStart}
            acceptsComposerDraft
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
