import React from "react";
import { useColorScheme } from "@/lib/useColorScheme";
import Logo from "@/assets/clarity-logo.svg";

export interface ClarityWordmarkProps {
  width?: number;
  height?: number;
  color?: string;
}

export function ClarityWordmark({ width = 256, height, color }: ClarityWordmarkProps) {
  const { colors } = useColorScheme();
  const fill = color ?? colors.foreground;

  // Original aspect ratio: 383:147
  const h = height ?? width * (147 / 383);

  return <Logo width={width} height={h} fill={fill} />;
}
