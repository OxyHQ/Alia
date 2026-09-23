import type { Suggestion } from '@/lib/hooks/use-suggestions';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useColorScheme } from '@/lib/useColorScheme';
import { IdentityMark } from '@alia.onl/sdk';
import { Chip } from '@oxy.so/bloom/chip';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { View } from 'react-native';

interface ChatEmptyStateProps {
  /** The welcome suggestions, or none — the heading and line stand alone. */
  suggestions?: readonly Suggestion[];
  onPickSuggestion?: (suggestion: Suggestion) => void;
}

/**
 * A chat with nothing in it yet: Bloom's `EmptyState` in the shape of
 * `AgentChat`'s — Alia's mark, a centred heading, one line, and the welcome
 * suggestions as wrapping pills under it.
 *
 * Each pill shows the suggestion's short title and hands the whole suggestion
 * back; what pressing it DOES (send it, or put a template in the composer) is
 * the screen's, because only the screen owns the submit path.
 */
export function ChatEmptyState({
  suggestions = [],
  onPickSuggestion,
}: ChatEmptyStateProps) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();

  return (
    <EmptyState
      illustration={<IdentityMark size={40} color={colors.primary} />}
      title={t('chat.emptyState.title')}
      description={t('chat.emptyState.description')}
      footer={
        suggestions.length === 0 || onPickSuggestion === undefined ? undefined : (
          <View className="flex-row flex-wrap justify-center gap-2">
            {suggestions.map((suggestion) => (
              <Chip
                key={suggestion.suggestionId}
                size="xl"
                variant="inverted"
                accessibilityLabel={suggestion.text}
                onPress={() => onPickSuggestion(suggestion)}
              >
                {suggestion.title || suggestion.text}
              </Chip>
            ))}
          </View>
        )
      }
    />
  );
}
