"use client"

import * as React from "react"
import * as HoverCardPrimitive from "@radix-ui/react-hover-card"
import { ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"
import Image from "next/image"

interface SourceProps extends React.ComponentPropsWithoutRef<"a"> {
  href: string
  title?: string
  description?: string
  showFavicon?: boolean
  children?: React.ReactNode
}

const Source = React.forwardRef<HTMLAnchorElement, SourceProps>(
  ({ className, href, title, description, showFavicon = true, children, ...props }, ref) => {
    let domain = ""
    let urlObj: URL | null = null
    try {
      const base = typeof window !== "undefined" ? window.location.origin : "http://localhost"
      urlObj = new URL(href, base)
      domain = urlObj.hostname.replace("www.", "")
    } catch (e) {
      domain = typeof window !== "undefined" ? window.location.hostname : ""
      urlObj = null
    }
    const faviconUrl = domain
      ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
      : ""
    const displayText = children || domain || href

    return (
      <HoverCardPrimitive.Root openDelay={200} closeDelay={100}>
        <HoverCardPrimitive.Trigger asChild>
          <a
            ref={ref}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted hover:border-muted-foreground/50",
              className
            )}
            {...props}
          >
            {showFavicon && faviconUrl && (
              <Image
                src={faviconUrl}
                alt=""
                width={14}
                height={14}
                className="rounded-sm"
                onError={(e) => {
                  e.currentTarget.style.display = "none"
                }}
              />
            )}
            <span className="truncate max-w-[140px]">{displayText}</span>
          </a>
        </HoverCardPrimitive.Trigger>

        {(title || description || href) && (
          <HoverCardPrimitive.Portal>
            <HoverCardPrimitive.Content
              className={cn(
                "z-50 w-80 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-none",
                "data-[state=open]:animate-in data-[state=closed]:animate-out",
                "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
                "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
                "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2"
              )}
              sideOffset={5}
            >
              <div className="flex flex-col gap-3">
                {/* Header with favicon and domain */}
                <div className="flex items-center gap-2">
                  {faviconUrl && (
                    <Image
                      src={faviconUrl}
                      alt=""
                      width={16}
                      height={16}
                      className="rounded-sm"
                      onError={(e) => {
                        e.currentTarget.style.display = "none"
                      }}
                    />
                  )}
                  {domain && (
                    <span className="text-xs font-medium text-muted-foreground truncate">
                      {domain}
                    </span>
                  )}
                </div>

                {/* Title */}
                {title && (
                  <h4 className="text-sm font-semibold leading-tight line-clamp-2">
                    {title}
                  </h4>
                )}

                {/* Description */}
                {description && (
                  <p className="text-sm text-muted-foreground line-clamp-3 leading-relaxed">
                    {description}
                  </p>
                )}

                {/* URL */}
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ExternalLink className="h-3 w-3" />
                  <span className="truncate">{href}</span>
                </div>
              </div>
            </HoverCardPrimitive.Content>
          </HoverCardPrimitive.Portal>
        )}
      </HoverCardPrimitive.Root>
    )
  }
)
Source.displayName = "Source"

export { Source }
