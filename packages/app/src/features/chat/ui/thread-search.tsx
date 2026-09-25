import {
  useThreadSearch,
  type ThreadSearchHit,
} from '@/features/chat/runtime/use-thread-search';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody } from '@oxy.so/bloom/card';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { Item } from '@oxy.so/bloom/item';
import { Search } from '@oxy.so/bloom/search';
import { Muted } from '@oxy.so/bloom/typography';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

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
 *
 * Bloom's `Search` for the field and an `Item` per hit, on a `Card` floating
 * over the top of the thread in its 768 column: the card is the surface, so
 * nothing here paints one of its own.
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

export const ThreadSearch = ({
  handle,
  onJump,
  onClose,
}: ThreadSearchProps) => {
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
    <View className="absolute inset-x-0 top-0 z-20 px-4 pt-4" pointerEvents="box-none">
      <View className="w-full max-w-[768px] self-center">
        <Card elevation="m">
          <CardBody>
            <View className="flex-row items-center gap-2">
              <View className="flex-1">
                <Search
                  label={t('chat.searchThreadPlaceholder')}
                  value={query}
                  onChangeText={setQuery}
                  onClearText={() => setQuery('')}
                  autoFocus
                  returnKeyType="search"
                />
              </View>
              <Button
                size="md"
                appearance="plain"
                tone="neutral"
                iconOnly
                leadingIcon={RiCloseLine}
                accessibilityLabel={t('common.close')}
                onPress={onClose}
              />
            </View>

            {!asked ? (
              <View className="px-1 py-4">
                <Muted>{t('chat.searchThreadHint')}</Muted>
              </View>
            ) : isError ? (
              <View className="px-1 py-4">
                <Muted>{t('chat.searchThreadFailed')}</Muted>
              </View>
            ) : found.length === 0 ? (
              <View className="px-1 py-4">
                <Muted>
                  {isFetching
                    ? t('chat.searchThreadSearching')
                    : t('chat.searchThreadEmpty')}
                </Muted>
              </View>
            ) : (
              <ScrollView
                // A height in px, not a percentage of a parent that has none:
                // measured in Chromium, the list otherwise sized itself to its
                // content and spilled the results over the thread behind it.
                className="mt-2 max-h-96"
                keyboardShouldPersistTaps="handled"
              >
                {found.map((hit) => (
                  <Item
                    // The cursor, never `messageId`: a message the server wrote
                    // has no client id, and `null` is not a key.
                    key={hit.cursor}
                    title={hit.snippet}
                    subtitle={`${t(
                      hit.role === 'user'
                        ? 'chat.searchThreadYou'
                        : 'chat.searchThreadAgent',
                    )} · ${hitDay(hit.createdAt, locale)}`}
                    onPress={() => onJump(hit)}
                  />
                ))}
              </ScrollView>
            )}
          </CardBody>
        </Card>
      </View>
    </View>
  );
};
