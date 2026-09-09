import { View, Pressable } from "react-native";
import { Globe } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useTranslation } from "@/lib/hooks/use-translation";
import { extractSources } from "@/lib/thought-utils";
import type { ToolInvocation } from "@/lib/types/messages";

/** How many domain marks the stack shows before it stops adding them. */
const STACK_LIMIT = 3;

/**
 * The row of sources under an answer that used the web.
 *
 * Until now the only way to a source was to notice that a finished tool line
 * was pressable — nothing on screen said so, and a reader who scrolled past it
 * had no second chance. This is the affordance: the domains that answer is
 * standing on, stated under it, opening the panel already on Sources.
 *
 * It reads `toolInvocations`, which is the same jsonb the message is stored
 * with, so a thread reopened next month shows the sources it was answered from
 * rather than nothing.
 */
export function MessageSources({
  toolInvocations,
  onPress,
}: {
  toolInvocations?: ToolInvocation[];
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const sources = extractSources(toolInvocations);
  if (sources.length === 0) return null;

  const stacked = sources.slice(0, STACK_LIMIT);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("chat.sourcesCount", { count: sources.length })}
      className="mt-2 flex-row items-center gap-2 self-start rounded-lg py-1.5 pe-3 ps-1 active:bg-muted hover:bg-muted"
      onPress={onPress}
    >
      {/* Reversed so the first source sits on top of the overlap, as read. */}
      <View className="flex-row-reverse">
        {[...stacked].reverse().map((source) => (
          <View
            key={source.url}
            className="-ms-1.5 h-5 w-5 items-center justify-center rounded-full border-2 border-background bg-muted first:me-0"
          >
            <Globe size={10} className="text-muted-foreground" />
          </View>
        ))}
      </View>
      <Text className="text-[13px] font-medium text-muted-foreground">
        {t("chat.sources")}
      </Text>
    </Pressable>
  );
}
