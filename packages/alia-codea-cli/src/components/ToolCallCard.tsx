import React from 'react';
import { Box, Text } from 'ink';
import { ToolExecution } from '../utils/conversation.js';
import { formatToolArgs } from '../utils/format.js';

interface ToolCallCardProps {
  execution: ToolExecution;
}

export function ToolCallCard({ execution }: ToolCallCardProps) {
  const { tool, args, result, success, approved } = execution;
  const argStr = formatToolArgs(tool, args);
  const isDone = result !== undefined;

  if (approved === false) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Box gap={1}>
          <Text color="red">{'✗'}</Text>
          <Text bold color="gray" strikethrough>{tool}</Text>
          <Text color="gray">{argStr}</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text color="yellow" dimColor>Declined by user</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box gap={1}>
        {isDone ? (
          <Text color={success ? 'green' : 'red'}>{success ? '✓' : '✗'}</Text>
        ) : (
          <Text color="cyan">{'→'}</Text>
        )}
        <Text bold>{tool}</Text>
        <Text color="gray">{argStr}</Text>
      </Box>
      {isDone && result && (
        <Box paddingLeft={2}>
          <Text color="gray" wrap="truncate-end">
            {result.slice(0, 120).replace(/\n/g, ' ')}{result.length > 120 ? '...' : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
}
