import React, { useMemo } from "react";
import { AliaFace, type AliaAccessory, type AliaExpression } from '@alia.onl/sdk';
import { getAccessory } from "@/lib/accessories";

export interface AgentPlaceholderProps {
  size?: number;
  accessories?: string[];
  expression?: AliaExpression;
}

export function AgentPlaceholder({
  size = 64,
  accessories,
  expression,
}: AgentPlaceholderProps) {
  const resolvedAccessories = useMemo<AliaAccessory[] | undefined>(() => {
    if (!accessories?.length) return undefined;
    const resolved: AliaAccessory[] = [];
    for (const id of accessories) {
      const acc = getAccessory(id);
      if (acc) resolved.push({ layer: acc.layer, image: acc.image });
    }
    return resolved.length > 0 ? resolved : undefined;
  }, [accessories]);

  return (
    <AliaFace
      size={size}
      expression={expression}
      accessories={resolvedAccessories}
    />
  );
}
