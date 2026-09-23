import { Text } from '@oxy.so/bloom/typography';
export function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase mb-2">
      {children}
    </Text>
  );
}
