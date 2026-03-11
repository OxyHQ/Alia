import React, { useMemo } from "react";
import { AliaFace as AliaFaceBase, type AliaAccessory, type AliaExpression } from '@alia.onl/sdk';
import { getAccessory, getAccessoryImage } from "@/lib/accessories";
import type { AgentAccessory } from "@/lib/stores/agents-store";
import { useAccessoriesStore } from "@/lib/stores/accessories-store";
import { useColorScheme } from "@/lib/useColorScheme";

export type { AliaExpression };

export interface AliaFaceProps {
  size?: number;
  accessories?: AgentAccessory[];
  expression?: AliaExpression;
}

export function AliaFace({
  size = 64,
  accessories,
  expression,
}: AliaFaceProps) {
  const catalog = useAccessoriesStore((s) => s.catalog);
  const { colors } = useColorScheme();

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
      } else {
        // Fallback: resolve from catalog's S3 URL for accessories not bundled locally
        const catalogItem = catalog.find((c) => c.slug === entry.accessoryId);
        const image = getAccessoryImage(entry.accessoryId, catalogItem?.imageUrl);
        if (image && catalogItem) {
          resolved.push({
            layer: catalogItem.layer,
            image,
            position: entry.position,
          });
        }
      }
    }
    return resolved.length > 0 ? resolved : undefined;
  }, [accessories, catalog]);

  return (
    <AliaFaceBase
      size={size}
      expression={expression}
      accessories={resolvedAccessories}
      backgroundColor={colors.background}
      borderColor={colors.border}
    />
  );
}
