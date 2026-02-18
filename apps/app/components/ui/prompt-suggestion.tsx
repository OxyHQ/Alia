import React from "react";
import { type PressableProps } from "react-native";
import { Button, buttonVariants } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { type VariantProps } from "class-variance-authority";

export type PromptSuggestionProps = PressableProps & {
  children: React.ReactNode;
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  className?: string;
  highlight?: string;
};

export function PromptSuggestion({
  children,
  variant,
  size,
  className,
  highlight,
  ...props
}: PromptSuggestionProps) {
  const isHighlightMode = highlight !== undefined && highlight.trim() !== "";
  const content = typeof children === "string" ? children : "";

  if (!isHighlightMode) {
    return (
      <Button
        variant={variant ?? "outline"}
        size={size ?? "lg"}
        className={cn("rounded-full", className)}
        {...props}
      >
        <Text>{children}</Text>
      </Button>
    );
  }

  if (!content) {
    return (
      <Button
        variant={variant ?? "ghost"}
        size={size ?? "sm"}
        className={cn(
          "w-full justify-start rounded-xl py-2",
          "web:hover:bg-accent active:bg-accent",
          className
        )}
        {...props}
      >
        <Text>{children}</Text>
      </Button>
    );
  }

  const trimmedHighlight = highlight!.trim();
  const contentLower = content.toLowerCase();
  const highlightLower = trimmedHighlight.toLowerCase();
  const index = contentLower.indexOf(highlightLower);

  const renderHighlighted = () => {
    if (index === -1) {
      return <Text className="text-muted-foreground">{content}</Text>;
    }

    const before = content.substring(0, index);
    const matched = content.substring(index, index + highlightLower.length);
    const after = content.substring(index + highlightLower.length);

    return (
      <Text>
        {before ? (
          <Text className="text-muted-foreground">{before}</Text>
        ) : null}
        <Text className="text-primary font-medium">{matched}</Text>
        {after ? (
          <Text className="text-muted-foreground">{after}</Text>
        ) : null}
      </Text>
    );
  };

  return (
    <Button
      variant={variant ?? "ghost"}
      size={size ?? "sm"}
      className={cn(
        "w-full justify-start rounded-xl py-2",
        "web:hover:bg-accent active:bg-accent",
        className
      )}
      {...props}
    >
      {renderHighlighted()}
    </Button>
  );
}
