import { useState } from "react";
import { View, Pressable, ScrollView } from "react-native";
import { X, Search } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useThreadSearch, type ThreadSearchHit } from "@/lib/hooks/use-thread-search";

/**
 * Searching what was said in this thread, across every conversation in it.
 *
 * Not the app-wide palette on ⌘K, and the difference is the point: that one
 * finds a chat, this one finds a SENTENCE, and it looks past the stretch on
 * screen into every one before it. `GET /conversations/:id/…` could not serve
 * this — it would stop at the current conversation, which is the one thing the
 * reader can already see.
 *
 * Each result carries the cursor that opens the thread around it. A result you
 * can read and not reach is a wall, so `onJump` is not an extra: it is what the
 * hit is for.
 */

interface ThreadSearchProps {
  /** The handle whose thread is searched. */
  handle: string;
  /** Open the thread around this message. */
  onJump: (hit: ThreadSearchHit) => void;
  onClose: () => void;
}

/** The day a hit was written, in the reader's own locale and timezone. */
function hitDay(createdAt: string, locale: string): string {
  return new Date(createdAt).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export const ThreadSearch = ({ handle, onJump, onClose }: ThreadSearchProps) => {
  const { t, locale } = useTranslation();
  const [query, setQuery] = useState('');
  const { data: hits, isFetching, isError } = useThreadSearch(handle, query);

  /**
   * Told apart deliberately: nothing typed is not a search that found nothing.
   * One is an invitation and the other is an answer, and saying "no results"
   * over an empty field answers a question nobody asked.
   */
  const asked = query.trim().length > 0;
  const found = hits ?? [];

  return (
    <View className="absolute inset-x-0 top-0 z-20 overflow-hidden border-b border-border bg-background px-4 pb-3 pt-4">
      <View className="mx-auto w-full max-w-3xl">
        <View className="flex-row items-center gap-2">
          <View className="flex-1 flex-row items-center gap-2 rounded-xl border border-input bg-background px-3">
            <Search size={16} className="text-muted-foreground" />
            <Input
              value={query}
              onChangeText={setQuery}
              placeholder={t('chat.searchThreadPlaceholder')}
              className="h-10 flex-1 border-0 px-0"
              autoFocus
              returnKeyType="search"
            />
          </View>
          <Button variant="ghost" size="icon" onPress={onClose} className="h-9 w-9 rounded-full">
            <X size={18} className="text-muted-foreground" />
          </Button>
        </View>

        {!asked ? (
          <Text className="px-1 py-4 text-sm text-muted-foreground">
            {t('chat.searchThreadHint')}
          </Text>
        ) : isError ? (
          <Text className="px-1 py-4 text-sm text-muted-foreground">
            {t('chat.searchThreadFailed')}
          </Text>
        ) : found.length === 0 ? (
          <Text className="px-1 py-4 text-sm text-muted-foreground">
            {isFetching ? t('chat.searchThreadSearching') : t('chat.searchThreadEmpty')}
          </Text>
        ) : (
          <ScrollView
            // A height in px, not a percentage of a parent that has none:
            // measured in Chromium, the list otherwise sized itself to its
            // content and spilled the results over the thread behind it.
            className="mt-2 max-h-96"
            keyboardShouldPersistTaps="handled"
          >
            {found.map((hit) => (
              <Pressable
                // The cursor, never `messageId`: a message the server wrote has
                // no client id, and `null` is not a key.
                key={hit.cursor}
                onPress={() => onJump(hit)}
                className="rounded-xl px-1 py-3 web:hover:bg-muted"
              >
                <View className="flex-row items-center justify-between gap-3">
                  <Text className="text-xs font-medium text-muted-foreground">
                    {t(hit.role === 'user' ? 'chat.searchThreadYou' : 'chat.searchThreadAgent')}
                  </Text>
                  <Text className="text-xs text-muted-foreground">{hitDay(hit.createdAt, locale)}</Text>
                </View>
                <Text className="mt-1 text-sm text-foreground" numberOfLines={2}>
                  {hit.snippet}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </View>
    </View>
  );
};
