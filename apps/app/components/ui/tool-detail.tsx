import React, { useState, useEffect } from "react";
import { View, ScrollView } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { CheckCircle, ChevronDown, Settings, XCircle } from "lucide-react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
} from "react-native-reanimated";

export type ToolPart = {
  type: string;
  state:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  toolCallId?: string;
  errorText?: string;
};

export type ToolDetailProps = {
  toolPart: ToolPart;
  defaultOpen?: boolean;
  className?: string;
};

function SpinningLoader() {
  const rotation = useSharedValue(0);

  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, { duration: 1000, easing: Easing.linear }),
      -1
    );
  }, [rotation]);

  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View style={spinStyle}>
      <Settings size={16} color="#3b82f6" />
    </Animated.View>
  );
}

const badgeStyles = {
  "input-streaming": "bg-blue-100 dark:bg-blue-900/30",
  "input-available": "bg-orange-100 dark:bg-orange-900/30",
  "output-available": "bg-green-100 dark:bg-green-900/30",
  "output-error": "bg-red-100 dark:bg-red-900/30",
} as const;

const badgeTextStyles = {
  "input-streaming": "text-blue-700 dark:text-blue-400",
  "input-available": "text-orange-700 dark:text-orange-400",
  "output-available": "text-green-700 dark:text-green-400",
  "output-error": "text-red-700 dark:text-red-400",
} as const;

const badgeLabels = {
  "input-streaming": "Processing",
  "input-available": "Ready",
  "output-available": "Completed",
  "output-error": "Error",
} as const;

function ToolDetail({ toolPart, defaultOpen = false, className }: ToolDetailProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const { state, input, output, toolCallId } = toolPart;

  const getStateIcon = () => {
    switch (state) {
      case "input-streaming":
        return <SpinningLoader />;
      case "input-available":
        return <Settings size={16} color="#f97316" />;
      case "output-available":
        return <CheckCircle size={16} color="#22c55e" />;
      case "output-error":
        return <XCircle size={16} color="#ef4444" />;
      default:
        return <Settings size={16} className="text-muted-foreground" />;
    }
  };

  const formatValue = (value: unknown): string => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return value;
    if (typeof value === "object") return JSON.stringify(value, null, 2);
    return String(value);
  };

  return (
    <View
      className={cn("mt-3 overflow-hidden rounded-lg border border-border", className)}
    >
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto w-full flex-row justify-between rounded-b-none px-3 py-2"
          >
            <View className="flex-row items-center gap-2">
              {getStateIcon()}
              <Text
                className="text-sm font-medium"
                style={{ fontFamily: "monospace" }}
              >
                {toolPart.type}
              </Text>
              <View
                className={cn(
                  "rounded-full px-2 py-0.5",
                  badgeStyles[state] ?? "bg-gray-100 dark:bg-gray-900/30"
                )}
              >
                <Text
                  className={cn(
                    "text-xs font-medium",
                    badgeTextStyles[state] ?? "text-gray-700 dark:text-gray-400"
                  )}
                >
                  {badgeLabels[state] ?? "Pending"}
                </Text>
              </View>
            </View>
            <View
              style={{
                transform: [{ rotate: isOpen ? "180deg" : "0deg" }],
              }}
            >
              <ChevronDown size={16} className="text-muted-foreground" />
            </View>
          </Button>
        </CollapsibleTrigger>

        <CollapsibleContent className="overflow-hidden border-t border-border">
          <View className="bg-background gap-3 p-3">
            {input && Object.keys(input).length > 0 && (
              <View>
                <Text className="mb-2 text-sm font-medium text-muted-foreground">
                  Input
                </Text>
                <View className="rounded border border-border bg-background p-2">
                  {Object.entries(input).map(([key, value]) => (
                    <View key={key} className="mb-1 flex-row flex-wrap">
                      <Text
                        className="text-sm text-muted-foreground"
                        style={{ fontFamily: "monospace" }}
                      >
                        {key}:{" "}
                      </Text>
                      <Text
                        className="text-sm text-foreground"
                        style={{ fontFamily: "monospace" }}
                      >
                        {formatValue(value)}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {output && (
              <View>
                <Text className="mb-2 text-sm font-medium text-muted-foreground">
                  Output
                </Text>
                <ScrollView
                  style={{ maxHeight: 240 }}
                  className="rounded border border-border bg-background p-2"
                >
                  <Text
                    className="text-sm text-foreground"
                    style={{ fontFamily: "monospace" }}
                  >
                    {formatValue(output)}
                  </Text>
                </ScrollView>
              </View>
            )}

            {state === "output-error" && toolPart.errorText && (
              <View>
                <Text className="mb-2 text-sm font-medium text-red-500">
                  Error
                </Text>
                <View className="rounded border border-red-200 bg-background p-2 dark:border-red-950 dark:bg-red-900/20">
                  <Text className="text-sm text-foreground">
                    {toolPart.errorText}
                  </Text>
                </View>
              </View>
            )}

            {state === "input-streaming" && (
              <Text className="text-sm text-muted-foreground">
                Processing tool call...
              </Text>
            )}

            {toolCallId && (
              <View className="border-t border-border pt-2">
                <Text
                  className="text-xs text-muted-foreground"
                  style={{ fontFamily: "monospace" }}
                >
                  Call ID: {toolCallId}
                </Text>
              </View>
            )}
          </View>
        </CollapsibleContent>
      </Collapsible>
    </View>
  );
}

export { ToolDetail };
