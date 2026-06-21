import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { ThinkingIndicator } from './ThinkingIndicator.js';

interface InputBarProps {
  onSubmit: (value: string) => void;
  isProcessing: boolean;
  thinkingLabel?: string;
}

export function InputBar({ onSubmit, isProcessing, thinkingLabel }: InputBarProps) {
  const [value, setValue] = useState('');

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setValue('');
    onSubmit(trimmed);
  };

  if (isProcessing) {
    return (
      <Box paddingX={1}>
        <ThinkingIndicator label={thinkingLabel || 'Thinking'} />
      </Box>
    );
  }

  return (
    <Box paddingX={1}>
      <Text color="cyan">{'❯ '}</Text>
      <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
    </Box>
  );
}
