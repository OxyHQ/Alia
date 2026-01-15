import type React from "react";
import type { PropsWithChildren } from "react";
import { Text } from "react-native";

const H1: React.FC<PropsWithChildren> = ({ children }) => {
  return (
    <Text className="font-inter-600 text-2xl font-bold md:text-3xl lg:text-4xl">
      {children}
    </Text>
  );
};

export default H1;
