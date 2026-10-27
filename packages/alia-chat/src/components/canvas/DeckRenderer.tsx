import { Muted, Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import { MarkdownRenderer } from './MarkdownRenderer';

export interface DeckSlide {
  title: string;
  subtitle?: string;
  bullets?: string[];
  body?: string;
  notes?: string;
}

interface DeckRendererProps {
  data: { slides?: DeckSlide[] };
}

/**
 * A slide deck, one card per slide in reading order. Presenting it is the host's
 * (Astro opens a deck in a tab of its own); here it is read like a document.
 */
export function DeckRenderer({ data }: DeckRendererProps) {
  const slides = Array.isArray(data.slides) ? data.slides : [];
  return (
    <View className="gap-3">
      {slides.map((slide, i) => (
        <View
          key={i}
          className="gap-2 rounded-2xl border border-border bg-background-tertiary-default p-4"
        >
          <View className="flex-row items-baseline justify-between gap-2">
            <Text variant="body-semibold">{slide.title}</Text>
            <Muted>{i + 1}</Muted>
          </View>
          {slide.subtitle ? <Muted>{slide.subtitle}</Muted> : null}
          {slide.bullets?.length ? (
            <MarkdownRenderer data={{ content: slide.bullets.map((b) => `- ${b}`).join('\n') }} />
          ) : null}
          {slide.body ? <MarkdownRenderer data={{ content: slide.body }} /> : null}
        </View>
      ))}
    </View>
  );
}
