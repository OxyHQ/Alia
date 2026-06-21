import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

interface ThinkingIndicatorProps {
  label?: string;
}

export function ThinkingIndicator({ label = 'Thinking' }: ThinkingIndicatorProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed((e) => e + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Box gap={1}>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      <Text bold>{label}</Text>
      <Text color="gray">({elapsed}s)</Text>
    </Box>
  );
}
