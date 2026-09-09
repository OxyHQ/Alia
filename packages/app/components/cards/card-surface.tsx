import type { ReactNode } from "react";
import { View } from "react-native";

/**
 * The shell a tool card is drawn in, inside the assistant's turn.
 *
 * One copy so the second card cannot arrive with a different radius or a
 * different border than the first, which is the whole reason it is here rather
 * than repeated: a card is recognisable as a card before it is read.
 */
export function CardSurface({ children }: { children: ReactNode }) {
  return (
    <View className="mt-3 w-full overflow-hidden rounded-2xl border border-border bg-card p-4">
      {children}
    </View>
  );
}
