import React, { useMemo } from "react";
import { AliaFace, type AliaAccessory, type AliaExpression } from '@alia.onl/sdk';
import { getAccessory } from "@/lib/accessories";
import type { AgentAccessory } from "@/lib/stores/agents-store";

export interface AgentPlaceholderProps {
  size?: number;
  accessories?: AgentAccessory[];
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
    for (const entry of accessories) {
      const acc = getAccessory(entry.accessoryId);
      if (acc) {
        resolved.push({
          layer: acc.layer,
          image: acc.image,
          position: entry.position,
        });
      }
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
