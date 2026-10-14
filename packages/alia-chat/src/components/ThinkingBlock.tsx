import { AgentThinking } from '@oxy.so/bloom/agent-thinking';
import { useEffect, useRef, useState } from 'react';
import { useLabels } from '../lib/labels';
import { AliaMarkdown } from './Markdown';

interface ThinkingBlockProps {
  /** The model's reasoning, as Markdown. */
  text: string;
  /** Still reasoning: the block opens, and closes again when this turns false. */
  streaming: boolean;
}

/**
 * A turn's reasoning, once it is done: Bloom's `AgentThinking` as a closed disclosure, "Thought
 * for N seconds", with the text set as Markdown. While the reasoning streams it draws nothing:
 * the avatar under the reply is the one indicator that the turn is thinking
 * (`AgentReplyIdentity`), and a second one beside it is noise. It still counts how long the stream
 * ran, because the message carries no duration.
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

  if (streaming) return null;

  return (
    <AgentThinking thinking={false} label={finishedLabel}>
      <AliaMarkdown content={text} />
    </AgentThinking>
  );
}
