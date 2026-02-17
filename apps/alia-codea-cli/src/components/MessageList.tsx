import React from 'react';
import { Box, Text } from 'ink';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { ToolCallCard } from './ToolCallCard.js';
import { ToolExecution } from '../utils/conversation.js';

export interface DisplayMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool' | 'info';
  content: string;
  toolExecution?: ToolExecution;
  streaming?: boolean;
}

interface MessageListProps {
  messages: DisplayMessage[];
}

const marked = new Marked(markedTerminal() as any);

function renderMarkdown(text: string): string {
  try {
    const rendered = marked.parse(text);
    if (typeof rendered === 'string') {
      return rendered.trimEnd();
    }
    return text;
  } catch {
    return text;
  }
}

function MessageBlock({ message }: { message: DisplayMessage }) {
  switch (message.type) {
    case 'user':
      return (
        <Box paddingLeft={1} paddingY={0}>
          <Text color="cyan">{'❯ '}</Text>
          <Text>{message.content}</Text>
        </Box>
      );

    case 'assistant':
      return (
        <Box flexDirection="column" paddingLeft={1}>
          <Box>
            <Text color="magenta">{'✦ '}</Text>
            <Text>{message.streaming ? message.content : renderMarkdown(message.content)}</Text>
          </Box>
        </Box>
      );

    case 'tool':
      if (message.toolExecution) {
        return <ToolCallCard execution={message.toolExecution} />;
      }
      return null;

    case 'info':
      return (
        <Box paddingLeft={1}>
          <Text color="blue">{'ℹ '}</Text>
          <Text color="gray">{message.content}</Text>
        </Box>
      );

    default:
      return null;
  }
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <Box flexDirection="column" flexGrow={1} gap={0}>
      {messages.map((msg) => (
        <MessageBlock key={msg.id} message={msg} />
      ))}
    </Box>
  );
}
