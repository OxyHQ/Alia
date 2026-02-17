import React from 'react';
import { Box, Text, useInput } from 'ink';
import { ToolExecution } from '../utils/conversation.js';
import { formatApprovalDescription } from '../utils/format.js';

interface ApprovalPromptProps {
  execution: ToolExecution;
  onResolve: (approved: boolean) => void;
}

export function ApprovalPrompt({ execution, onResolve }: ApprovalPromptProps) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') {
      onResolve(true);
    } else if (input === 'n' || input === 'N' || key.escape) {
      onResolve(false);
    }
  });

  const description = formatApprovalDescription(execution.tool, execution.args);

  return (
    <Box flexDirection="column" paddingLeft={2} paddingY={0}>
      <Box gap={1}>
        <Text color="yellow">{'⚠'}</Text>
        <Text bold>{description}</Text>
      </Box>
      {execution.tool === 'run_command' && Boolean(execution.args.command) && (
        <Box paddingLeft={2}>
          <Text color="gray">$ {String(execution.args.command)}</Text>
        </Box>
      )}
      {execution.tool === 'write_file' && Boolean(execution.args.content) && (
        <Box paddingLeft={2}>
          <Text color="gray">{String(execution.args.content).split('\n').length} lines</Text>
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
