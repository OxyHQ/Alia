"use client"

import * as React from "react"
import { useControllableState } from "@radix-ui/react-use-controllable-state"
import { Brain, Check, Dot, Loader2, LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

// Context for managing the chain of thought state
type ChainOfThoughtContextValue = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const ChainOfThoughtContext = React.createContext<
  ChainOfThoughtContextValue | undefined
>(undefined)

function useChainOfThought() {
  const context = React.useContext(ChainOfThoughtContext)
  if (!context) {
    throw new Error(
      "ChainOfThought components must be used within a ChainOfThought provider"
    )
  }
  return context
}

// Main ChainOfThought component
export interface ChainOfThoughtProps
  extends React.ComponentPropsWithoutRef<"div"> {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export function ChainOfThought({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  className,
  children,
  ...props
}: ChainOfThoughtProps) {
  const [open = false, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  })

  return (
    <ChainOfThoughtContext.Provider
      value={{ open, onOpenChange: setOpen }}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div
          className={cn(
            "rounded-lg border bg-card text-card-foreground shadow-sm",
            className
          )}
          {...props}
        >
          {children}
        </div>
      </Collapsible>
    </ChainOfThoughtContext.Provider>
  )
}

// Header component
export interface ChainOfThoughtHeaderProps
  extends React.ComponentPropsWithoutRef<typeof CollapsibleTrigger> {
  children?: React.ReactNode
}

export function ChainOfThoughtHeader({
  children = "Chain of Thought",
  className,
  ...props
}: ChainOfThoughtHeaderProps) {
  const { open } = useChainOfThought()

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-2 px-4 py-3 font-medium transition-colors hover:bg-muted/50",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm">{children}</span>
      </div>
      <svg
        className={cn(
          "h-4 w-4 transition-transform duration-200",
          open && "rotate-180"
        )}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </CollapsibleTrigger>
  )
}

// Step component
export interface ChainOfThoughtStepProps
  extends React.ComponentPropsWithoutRef<"div"> {
  icon?: LucideIcon
  label?: string
  description?: string
  status?: "complete" | "active" | "pending"
}

export function ChainOfThoughtStep({
  icon: Icon = Dot,
  label,
  description,
  status = "complete",
  className,
  children,
  ...props
}: ChainOfThoughtStepProps) {
  const statusIcon = {
    complete: Check,
    active: Loader2,
    pending: Dot,
  }[status]

  const StatusIcon = statusIcon

  return (
    <div className={cn("flex gap-3", className)} {...props}>
      <div className="flex flex-col items-center">
        <div
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full border-2",
            status === "complete" &&
              "border-primary bg-primary text-primary-foreground",
            status === "active" &&
              "border-primary bg-background text-primary",
            status === "pending" &&
              "border-muted-foreground/30 bg-background text-muted-foreground"
          )}
        >
          <StatusIcon
            className={cn(
              "h-4 w-4",
              status === "active" && "animate-spin"
            )}
          />
        </div>
        {children && (
          <div className="h-full w-px bg-border my-2" />
        )}
      </div>
      <div className="flex-1 pb-4">
        {label && (
          <div className="font-medium text-sm mb-1">{label}</div>
        )}
        {description && (
          <div className="text-sm text-muted-foreground">
            {description}
          </div>
        )}
        {children && <div className="mt-2">{children}</div>}
      </div>
    </div>
  )
}

// Content component
export interface ChainOfThoughtContentProps
  extends React.ComponentPropsWithoutRef<typeof CollapsibleContent> {}

export function ChainOfThoughtContent({
  className,
  children,
  ...props
}: ChainOfThoughtContentProps) {
  return (
    <CollapsibleContent
      className={cn("border-t px-4 py-4", className)}
      {...props}
    >
      <div className="space-y-4">{children}</div>
    </CollapsibleContent>
  )
}

// Search Results container
export interface ChainOfThoughtSearchResultsProps
  extends React.ComponentPropsWithoutRef<"div"> {}

export function ChainOfThoughtSearchResults({
  className,
  children,
  ...props
}: ChainOfThoughtSearchResultsProps) {
  return (
    <div
      className={cn("flex flex-wrap gap-2", className)}
      {...props}
    >
      {children}
    </div>
  )
}

// Search Result badge
export interface ChainOfThoughtSearchResultProps
  extends React.ComponentPropsWithoutRef<typeof Badge> {}

export function ChainOfThoughtSearchResult({
  className,
  variant = "secondary",
  children,
  ...props
}: ChainOfThoughtSearchResultProps) {
  return (
    <Badge
      variant={variant}
      className={cn("text-xs", className)}
      {...props}
    >
      {children}
    </Badge>
  )
}

// Image component
export interface ChainOfThoughtImageProps
  extends React.ComponentPropsWithoutRef<"div"> {
  caption?: string
}

export function ChainOfThoughtImage({
  caption,
  className,
  children,
  ...props
}: ChainOfThoughtImageProps) {
  return (
    <div className={cn("space-y-2", className)} {...props}>
      <div className="overflow-hidden rounded-lg border bg-muted">
        {children}
      </div>
      {caption && (
        <p className="text-xs text-muted-foreground italic">{caption}</p>
      )}
    </div>
  )
}
