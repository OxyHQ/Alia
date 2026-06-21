import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Copy, Check } from 'lucide-react-native';
import { useState } from 'react';
import * as Clipboard from 'expo-clipboard';

interface CodeData {
  language: string;
  code: string;
}

interface CodeRendererProps {
  data: CodeData;
}

export function CodeRenderer({ data }: CodeRendererProps) {
  const { language, code } = data;
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View className="rounded-lg overflow-hidden" style={{ backgroundColor: '#18181b' }}>
      <View className="flex-row items-center justify-between px-3 py-2 border-b" style={{ borderBottomColor: '#27272a' }}>
        <Text className="text-xs font-medium" style={{ color: '#a1a1aa' }}>{language}</Text>
        <Pressable onPress={handleCopy} className="flex-row items-center gap-1 active:opacity-70">
          {copied ? (
            <Check size={14} color="#22c55e" />
          ) : (
            <Copy size={14} color="#a1a1aa" />
          )}
          <Text className="text-xs" style={{ color: '#a1a1aa' }}>{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={true}>
        <View className="p-3">
          <Text style={{ fontFamily: 'monospace', fontSize: 13, color: '#e4e4e7', lineHeight: 20 }}>
            {code}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
