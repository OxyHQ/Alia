import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { ContentPanel } from "@oxyhq/bloom/content-panel";
import { Text } from "@/components/ui/text";
import { ConversationScreen } from "@/components/conversation-screen";
import { useAgentThread } from "@/lib/hooks/use-agent-thread";
import { useTranslation } from "@/lib/hooks/use-translation";

/**
 * `/a/pepe` — the permanent thread with one agent.
 *
 * The conversation LIVES here. This route does not hand off to `/c/:id`: the
 * pair (person, agent) has one thread, and this URL is its address, so coming
 * back tomorrow is the same page rather than a new chat in the sidebar.
 *
 * Everything below the identity is the ordinary conversation screen, which is
 * why this file is short — see `components/conversation-screen.tsx`.
 */
const AgentThreadPage = () => {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { t } = useTranslation();
  const { data: thread, isPending, isError } = useAgentThread(username);

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
   * known: the username in the URL is the handle this person followed, so an
   * agent whose Oxy account resolved nothing still gets called what they called
   * it rather than being renamed to a noun.
   */
  const headerName = thread.agent.name?.trim() || thread.agent.handle?.trim() || username;

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
