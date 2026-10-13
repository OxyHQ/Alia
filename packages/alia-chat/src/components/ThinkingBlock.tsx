import { AgentThinking } from '@oxy.so/bloom/agent-thinking';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useLabels } from '../lib/labels';
import { AliaMarkdown } from './Markdown';

interface ThinkingBlockProps {
  /** The model's reasoning, as Markdown. */
  text: string;
  /** Still reasoning: the block opens, and closes again when this turns false. */
  streaming: boolean;
}

/**
 * A turn's reasoning: Bloom's `AgentThinking` as a disclosure (live while it
 * streams, "Thought for N seconds" once done), with the text set as Markdown.
 * Open and close, the indicator and the chevron are Bloom's; this only counts
 * how long the stream ran, because the message carries no duration.
 */
export function ThinkingBlock({ text, streaming }: ThinkingBlockProps) {
  const labels = useLabels();
  const startedAt = useRef<number | null>(null);
  const [seconds, setSeconds] = useState<number>();

  useEffect(() => {
    if (streaming) {
      startedAt.current = Date.now();
    } else if (startedAt.current !== null) {
      setSeconds(Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)));
      startedAt.current = null;
    }
  }, [streaming]);

  const finishedLabel = seconds ? labels.thoughtFor(seconds) : labels.reasoning;

  return (
    <AgentThinking
      variant="stars"
      thinking={streaming}
      label={streaming ? undefined : finishedLabel}
    >
      <View style={{ opacity: streaming ? 0.8 : 1 }}>
        <AliaMarkdown content={text} />
      </View>
    </AgentThinking>
  );
}
