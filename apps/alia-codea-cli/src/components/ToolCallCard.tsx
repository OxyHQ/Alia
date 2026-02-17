import React from 'react';
import { Box, Text } from 'ink';
import { ToolExecution } from '../utils/conversation.js';

interface ToolCallCardProps {
  execution: ToolExecution;
}

function formatArgs(tool: string, args: Record<string, any>): string {
  switch (tool) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return args.path || '';
    case 'apply_patch':
      return 'applying patch...';
    case 'list_files':
      return args.path || '.';
    case 'search_files':
      return `"${args.pattern}" in ${args.path || '.'}`;
    case 'run_command':
      return args.command || '';
    default:
      return JSON.stringify(args).slice(0, 60);
  }
}

export function ToolCallCard({ execution }: ToolCallCardProps) {
  const { tool, args, result, success, approved } = execution;
  const argStr = formatArgs(tool, args);
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
