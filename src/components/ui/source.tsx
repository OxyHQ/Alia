"use client"

import * as React from "react"
import Link from "next/link"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { cn } from "@/lib/utils"
import { LinkExternal01Icon } from "@hugeicons/core-free-icons"
import { createIcon } from "@/components/ui/hugeicon"

const ExternalLink = createIcon(LinkExternal01Icon)

export type SourceProps = {
  href?: string
  children: React.ReactNode
  className?: string
}

export function Source({ href, children, className }: SourceProps) {
  return (
    <span className={cn("inline-block", className)}>
      <HoverCard openDelay={200} closeDelay={100}>{children}</HoverCard>
    </span>
  )
}

export type SourceTriggerProps = {
  label: string
  showFavicon?: boolean
  className?: string
  asChild?: boolean
  children?: React.ReactNode
}

export function SourceTrigger({
  label,
  showFavicon = false,
  className,
  asChild,
  children,
  ...props
}: SourceTriggerProps) {
  const triggerContent = (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer",
        className
      )}
      {...props}
    >
      {showFavicon && (
        <span className="flex h-3 w-3 items-center justify-center rounded-sm bg-muted">
          <ExternalLink className="h-2 w-2" />
        </span>
      )}
      <span className="truncate max-w-[120px]">{label}</span>
    </div>
  )

  return (
    <HoverCardTrigger asChild={asChild}>
      {asChild && children ? children : triggerContent}
    </HoverCardTrigger>
  )
}

export type SourceContentProps = {
  title?: string
  description?: string
  href?: string
  children?: React.ReactNode
  className?: string
}

export function SourceContent({
  title,
  description,
  href,
  children,
  className,
}: SourceContentProps) {
  const content = (
    <div className={cn("space-y-2", className)}>
      {title && (
        <div className="font-semibold text-sm leading-tight line-clamp-2">{title}</div>
      )}
      {description && (
        <div className="text-xs text-muted-foreground">{description}</div>
      )}
      {children}
    </div>
  )

  if (href) {
    return (
      <HoverCardContent>
        <Link
          href={href}
          className="block"
          target="_blank"
          rel="noopener noreferrer"
        >
          {content}
        </Link>
      </HoverCardContent>
    )
  }

  return <HoverCardContent>{content}</HoverCardContent>
}
