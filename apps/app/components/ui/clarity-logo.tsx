import React from "react";
import { ClarityLogo as ClarityLogoBase, type ClarityExpression } from '@clarity/sdk';

export type { ClarityExpression };

export interface ClarityLogoProps {
  size?: number;
  accessories?: Array<{ accessoryId: string; position: { x: number; y: number; scale: number; rotation: number } }>;
  expression?: ClarityExpression;
}

export function ClarityLogo({
  size = 64,
  expression,
}: ClarityLogoProps) {
  return (
    <ClarityLogoBase
      size={size}
      expression={expression}
    />
  );
}
