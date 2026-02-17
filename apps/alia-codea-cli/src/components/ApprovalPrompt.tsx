import React from 'react';
import { Box, Text, useInput } from 'ink';
import { ToolExecution } from '../utils/conversation.js';

interface ApprovalPromptProps {
  execution: ToolExecution;
  onResolve: (approved: boolean) => void;
}

function formatArgs(tool: string, args: Record<string, any>): string {
  switch (tool) {
    case 'write_file':
      return `Write to ${args.path}`;
    case 'edit_file':
      return `Edit ${args.path}`;
    case 'apply_patch':
      return `Apply patch`;
    case 'run_command':
      return `Run: ${args.command}`;
    default:
      return `${tool}: ${JSON.stringify(args).slice(0, 80)}`;
  }
}

export function ApprovalPrompt({ execution, onResolve }: ApprovalPromptProps) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') {
      onResolve(true);
    } else if (input === 'n' || input === 'N' || key.escape) {
      onResolve(false);
    }
  });

  const description = formatArgs(execution.tool, execution.args);

  return (
    <Box flexDirection="column" paddingLeft={2} paddingY={0}>
      <Box gap={1}>
        <Text color="yellow">{'⚠'}</Text>
        <Text bold>{description}</Text>
      </Box>
      {execution.tool === 'run_command' && execution.args.command && (
        <Box paddingLeft={2}>
          <Text color="gray">$ {execution.args.command}</Text>
        </Box>
      )}
      {execution.tool === 'write_file' && execution.args.content && (
        <Box paddingLeft={2}>
          <Text color="gray">{execution.args.content.split('\n').length} lines</Text>
        </Box>
      )}
      <Box paddingLeft={2} gap={1}>
        <Text color="green">[y]</Text>
        <Text>approve</Text>
        <Text color="red">[n]</Text>
        <Text>deny</Text>
      </Box>
    </Box>
  );
}
