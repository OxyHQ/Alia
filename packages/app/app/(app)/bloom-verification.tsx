import { FileCard } from '@/components/file-card';
import { Button } from '@oxy.so/bloom/button';
import { useUIStore } from '@/lib/stores/ui-store';
import { rememberOpener } from '@/components/execution/focus-return';
import { useState } from 'react';
import { View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
export default function Verification() {
  const [result, setResult] = useState('Ready');
  return <View style={{ width: 320, padding: 20 }}><Text>Local UI fixture — no server writes</Text><Button accessibilityLabel="Open Thought panel" onPress={() => { rememberOpener(); useUIStore.getState().setRightPanel("thought"); }}>Open Thought panel</Button><View testID="file-fixture"><FileCard file={{ id: "fixture-file", name: "Verify file menu", category: "documents", type: "text/plain", size: 42, createdAt: new Date() } as never} onPress={() => setResult("File opened")} onDelete={() => setResult("File deleted locally")} /></View><Text testID="result">{result}</Text></View>;
}
