import React from 'react';
import { Box, Text } from 'ink';
import { ApprovalMode } from '../utils/approval.js';

interface HeaderProps {
  cwd: string;
  model: string;
  approvalMode: ApprovalMode;
  contextPercent: number;
}

function shortenPath(p: string): string {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

const MODE_COLORS: Record<ApprovalMode, string> = {
  'suggest': 'yellow',
  'auto-edit': 'cyan',
  'full-auto': 'green',
};

export function Header({ cwd, model, approvalMode, contextPercent }: HeaderProps) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text color="cyan">{shortenPath(cwd)}</Text>
      <Box gap={1}>
        <Text color="magenta">{model}</Text>
        <Text color="gray">|</Text>
        <Text color={MODE_COLORS[approvalMode]}>{approvalMode}</Text>
        <Text color="gray">|</Text>
        <Text color={contextPercent < 20 ? 'red' : 'gray'}>{contextPercent}% left</Text>
      </Box>
    </Box>
  );
}
