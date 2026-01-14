"use client"

import * as React from "react"
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

const StepsRoot = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>
>(({ className, defaultOpen = true, ...props }, ref) => (
  <CollapsiblePrimitive.Root
    ref={ref}
    defaultOpen={defaultOpen}
    className={cn("w-full", className)}
    {...props}
  />
))
StepsRoot.displayName = "StepsRoot"

interface StepsTriggerProps
  extends React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger> {
  leftIcon?: React.ReactNode
  swapIconOnHover?: boolean
}

const StepsTrigger = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Trigger>,
  StepsTriggerProps
>(({ className, children, leftIcon, swapIconOnHover = true, ...props }, ref) => {
  const [isOpen, setIsOpen] = React.useState(props.defaultChecked ?? true)

  return (
    <CollapsiblePrimitive.Trigger
      ref={ref}
      className={cn(
        "group flex w-full items-center gap-2 rounded-lg p-2 text-sm font-medium transition-colors hover:bg-muted/50",
        className
      )}
      onClick={() => setIsOpen(!isOpen)}
      {...props}
    >
      <div className="flex items-center gap-2 flex-1">
        {leftIcon && (
          <div
            className={cn(
              "flex h-5 w-5 items-center justify-center transition-opacity",
              swapIconOnHover && "group-hover:opacity-0"
            )}
          >
            {leftIcon}
          </div>
        )}
        {swapIconOnHover && leftIcon && (
          <ChevronDown
            className={cn(
              "absolute h-4 w-4 opacity-0 transition-all group-hover:opacity-100",
              isOpen && "rotate-180"
            )}
          />
        )}
        {!leftIcon && (
          <ChevronDown
            className={cn(
              "h-4 w-4 transition-transform",
              isOpen && "rotate-180"
            )}
          />
        )}
        <span className="flex-1 text-left">{children}</span>
      </div>
    </CollapsiblePrimitive.Trigger>
  )
})
StepsTrigger.displayName = "StepsTrigger"

interface StepsContentProps
  extends React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content> {
  bar?: React.ReactNode
}

const StepsContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Content>,
  StepsContentProps
>(({ className, children, bar = <StepsBar />, ...props }, ref) => (
  <CollapsiblePrimitive.Content
    ref={ref}
    className={cn("overflow-hidden", className)}
    {...props}
  >
    <div className="relative flex gap-3 pl-2 pt-2">
      {bar}
      <div className="flex-1 space-y-2 pb-2">{children}</div>
    </div>
  </CollapsiblePrimitive.Content>
))
StepsContent.displayName = "StepsContent"

const StepsBar = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("h-full w-[2px] bg-muted", className)}
    {...props}
  />
))
StepsBar.displayName = "StepsBar"

const StepsItem = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  >
    {children}
  </div>
))
StepsItem.displayName = "StepsItem"

const Steps = StepsRoot

export { Steps, StepsRoot, StepsTrigger, StepsContent, StepsBar, StepsItem }
