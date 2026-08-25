import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { ContentPanel } from "@oxyhq/bloom/content-panel";
import { Text } from "@/components/ui/text";
import { ConversationScreen } from "@/components/conversation-screen";
import { useAgentThread } from "@/lib/hooks/use-agent-thread";
import { useTranslation } from "@/lib/hooks/use-translation";

/**
 * `/@pepe` — the permanent thread with one agent.
 *
 * The conversation LIVES here. This route does not hand off to `/c/:id`: the
 * pair (person, agent) has one thread, and this URL is its address, so coming
 * back tomorrow is the same page rather than a new chat in the sidebar.
 *
 * ## The `@` is in the VALUE, not in the filename
 *
 * Expo Router does not mix static text with a dynamic segment, so there is no
 * `@[username].tsx`. `/@pepe` matches this file with `username` set to the whole
 * `"@pepe"`, and the sigil is stripped here — the same shape Mention uses.
 *
 * ## Which makes this the app's catch-all for one-segment paths
 *
 * A dynamic segment at the root of the group swallows every single-segment URL
 * that no static route claims. Expo Router prefers a static route over a dynamic
 * one, so `/settings` still reaches `settings` — asserted for every static route
 * and directory in `__tests__/single-segment-routes.test.ts`, because that
 * preference is the only thing standing between this file and the rest of the
 * app.
 *
 * What it does mean is that `/anything-that-is-not-a-route` lands HERE and gets
 * the agent 404. That is deliberate rather than a side effect: the thread's
 * refusal is already built to reveal nothing — an agent that does not exist, an
 * agent you cannot reach and a path that is not a route are one answer — and a
 * separate generic 404 would be a second page saying less.
 *
 * Everything below the identity is the ordinary conversation screen, which is
 * why this file is short — see `components/conversation-screen.tsx`.
 */
const AgentThreadPage = () => {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { t } = useTranslation();

  /**
   * The handle Oxy knows, stripped of the sigil the URL carries.
   *
   * Normalised in ONE place and for any number of `@`: `/@pepe`, `/pepe` and
   * `/@@pepe` are the same person, and three spellings that reached three
   * behaviours would be three bugs nobody could tell apart. What goes to the API
   * is the bare username, which is what `GET /agents/thread/:username` expects.
   */
  const handle = username?.replace(/^@+/, '') ?? '';
  const { data: thread, isPending, isError } = useAgentThread(handle);

  /**
   * An agent that does not exist and an agent this person cannot reach are ONE
   * state, deliberately: the API answers 404 for both, and this screen says the
   * same thing about both. A distinct "you don't have access" would confirm the
   * agent exists, which is what an unpublished agent's owner did not agree to.
   *
   * Every other error lands here too. That is not a compromise — a screen that
   * distinguished "not found" from "we couldn't ask" would leak the same fact
   * whenever the second only ever happens for one of them.
   */
  if (isError) {
    return (
      <ContentPanel surfaceClassName="bg-background">
        <View className="flex-1 items-center justify-center">
          <Text className="text-muted-foreground">{t("agents.notFound")}</Text>
        </View>
      </ContentPanel>
    );
  }

  if (isPending || thread === undefined) {
    return (
      <ContentPanel surfaceClassName="bg-background">
        <View className="flex-1 items-center justify-center">
          <Text className="text-muted-foreground">{t("common.loading")}</Text>
        </View>
      </ContentPanel>
    );
  }

  /**
   * The name the header shows.
   *
   * `agentDisplayName` ends at the generic word "Agent", which is right for a
   * listing where nothing else is known about the row. Here something else IS
   * known: the handle in the URL is what this person followed, so an agent whose
   * Oxy account resolved nothing still gets called what they called it rather
   * than being renamed to a noun.
   */
  const headerName = thread.agent.name?.trim() || thread.agent.handle?.trim() || handle;

  return (
    <ConversationScreen
      conversationId={thread.conversationId}
      agentId={thread.agent._id}
      agentName={headerName}
      agentColor={thread.agent.color}
    />
  );
};

export default AgentThreadPage;
