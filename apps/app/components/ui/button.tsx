import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Pressable, ActivityIndicator } from "react-native";
import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group flex items-center justify-center rounded-xl web:ring-offset-background web:transition-colors web:focus-visible:outline-none web:focus-visible:ring-2 web:focus-visible:ring-ring web:focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default: "bg-primary web:hover:opacity-90 active:opacity-90",
        destructive: "bg-destructive web:hover:opacity-90 active:opacity-90",
        outline:
          "border border-input bg-background web:hover:bg-accent web:hover:text-accent-foreground active:bg-accent",
        secondary: "bg-secondary web:hover:opacity-80 active:opacity-80",
        ghost:
          "web:hover:bg-accent web:hover:text-accent-foreground active:bg-accent",
        link: "web:underline-offset-4 web:hover:underline web:focus:underline ",
        pill: "text-primary-foreground rounded-full bg-black web:hover:opacity-90 active:opacity-90",
      },
      size: {
        // default: "h-10 px-4 py-2 native:h-12 native:max-h-11 native:px-5 native:py-3",
        //NOTE: rofi - added this fix for height
        default: "h-9 px-3.5 py-2 native:h-11 native:px-4",
        sm: "h-8 rounded-lg px-2.5",
        lg: "h-10 rounded-xl px-6 native:h-12",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const buttonTextVariants = cva(
  "web:whitespace-nowrap text-sm native:text-base font-medium text-foreground web:transition-colors",
  {
    variants: {
      variant: {
        default: "text-primary-foreground",
        destructive: "text-destructive-foreground",
        outline: "group-active:text-accent-foreground",
        secondary:
          "text-secondary-foreground group-active:text-secondary-foreground",
        ghost: "group-active:text-accent-foreground",
        link: "text-primary group-active:underline",
        pill: "text-primary-foreground",
      },
      size: {
        default: "",
        sm: "",
        lg: "native:text-lg",
        icon: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = React.ComponentPropsWithoutRef<typeof Pressable> &
  VariantProps<typeof buttonVariants> & {
    isLoading?: boolean;
  };

const Button = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  ButtonProps
>(({ className, variant, size, isLoading, children, ...props }, ref) => {
  return (
    <TextClassContext.Provider
      value={cn(
        props.disabled && "web:pointer-events-none",
        buttonTextVariants({ variant, size }),
      )}
    >
      <Pressable
        className={cn(
          props.disabled && "opacity-50 web:pointer-events-none",
          isLoading && "web:pointer-events-none",
          buttonVariants({ variant, size, className }),
        )}
        ref={ref}
        role="button"
        {...props}
      >
        {isLoading ? (
          <ActivityIndicator
            color={variant === "outline" ? "black" : "white"}
          />
        ) : (
          children
        )}
      </Pressable>
    </TextClassContext.Provider>
  );
});
Button.displayName = "Button";

export { Button, buttonTextVariants, buttonVariants };
export type { ButtonProps };
