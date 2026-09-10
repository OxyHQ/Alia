import { useState } from "react";
import { View, Pressable } from "react-native";
import { Image } from "expo-image";
import { Globe } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useTranslation } from "@/lib/hooks/use-translation";
import config from "@/lib/config";
import { extractSources, mergeSources, researchSourcesToSources } from "@/lib/thought-utils";
import type { ToolInvocation } from "@/lib/types/messages";

/** How many domain marks the stack shows before it stops adding them. */
const STACK_LIMIT = 3;

/**
 * One source's mark: the site's own icon, on the globe it falls back to.
 *
 * The icon comes from Alia's API, never from a public favicon service. A
 * service would receive one request per source straight from the reader's
 * browser — which publication, which reader, which minute — and that adds up to
 * the reading habits of everyone using Alia, held by a company with no part in
 * this. `packages/api/src/lib/favicon.ts` fetches it server-side instead, and
 * says what that costs.
 *
 * The globe is rendered underneath rather than after a failure, so the two
 * states that are not "loaded" — still fetching, and no icon at all — look the
 * same and neither is a gap in the row. Most sources will not have an icon
 * within the first frame, and a mark that appears late is a row that moves
 * under the reader.
 */
function SourceMark({ domain }: { domain: string }) {
  const [status, setStatus] = useState<"pending" | "loaded" | "failed">("pending");

  return (
    <View className="-ms-1.5 h-5 w-5 items-center justify-center overflow-hidden rounded-full border-2 border-background bg-muted first:me-0">
      {status === "loaded" ? null : <Globe size={10} className="text-muted-foreground" />}
      {status === "failed" ? null : (
        <Image
          source={{ uri: `${config.apiUrl}/favicons/${encodeURIComponent(domain)}` }}
          className="absolute h-full w-full"
          contentFit="contain"
          accessible={false}
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("failed")}
        />
      )}
    </View>
  );
}

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
 *
 * A research answer is saved with its sources as a `deepResearch` invocation,
 * which `extractSources` reads like any other. While it is still the live
 * turn that record does not exist yet — the sources arrive on the final
 * `alia.research_progress` event instead — so `researchSources` takes those,
 * and the row is the same before and after a reload.
 */
export function MessageSources({
  toolInvocations,
  researchSources,
  onPress,
}: {
  toolInvocations?: ToolInvocation[];
  /** `researchProgress.sources` of a live research answer. */
  researchSources?: Array<{ id: number; url: string; title: string }> | null;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const sources = mergeSources(extractSources(toolInvocations), researchSourcesToSources(researchSources));
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
          <SourceMark key={source.url} domain={source.domain} />
        ))}
      </View>
      <Text className="text-[13px] font-medium text-muted-foreground">
        {t("chat.sources")}
      </Text>
    </Pressable>
  );
}
