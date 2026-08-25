import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { AgentGlyph } from "@/components/ui/agent-glyph";
import { formatRelativeTime } from "@/lib/utils/relative-time";

/**
 * One agent in the sidebar, read as a chat rather than as a name.
 *
 * Two lines — who it is, and the last thing said in YOUR thread with it — which
 * is why this is not a `SidebarRow`: that primitive is one fixed-height line, and
 * the whole point here is the second one.
 *
 * The last message and its time arrive on the agent itself from `GET /agents/me`,
 * gathered for the whole list in a single query. Nothing here fetches.
 */
export function AgentRow({
  name,
  handle,
  color,
  lastMessage,
  lastMessageAt,
  emptyLabel,
  onPress,
}: {
  name: string;
  handle: string;
  color: string | null;
  lastMessage: string | null | undefined;
  lastMessageAt: string | null | undefined;
  /** What the second line says before anything has been said. */
  emptyLabel: string;
  onPress: () => void;
}) {
  /*
   * An agent nobody has spoken to yet is the ORDINARY case — you have just made
   * it — so the second line always has something to say. Falling back to an
   * empty string would collapse the row to one line and make a new agent look
   * broken next to its neighbours.
   */
  const preview = lastMessage ?? emptyLabel;
  const when = lastMessageAt === null || lastMessageAt === undefined
    ? null
    : formatRelativeTime(lastMessageAt);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={handle.length > 0 ? `@${handle}` : name}
      onPress={onPress}
      className="w-full flex-row items-center gap-2 rounded-xl px-1.5 py-1.5 hover:bg-muted active:bg-muted"
    >
      <AgentGlyph size={28} color={color} label={name} />
      {/*
        `min-w-0` is what lets both lines truncate instead of widening the row:
        a flex child will not shrink past its content without it, so a long
        message would push the sidebar rather than ellipsing inside it.
      */}
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
            {name}
          </Text>
          {when === null ? null : (
            <Text className="shrink-0 text-[11px] text-muted-foreground">{when}</Text>
          )}
        </View>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {preview}
        </Text>
      </View>
    </Pressable>
  );
}
