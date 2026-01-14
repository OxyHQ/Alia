import * as React from "react"
import { cn } from "@/lib/utils"

const Item = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { variant?: string, size?: string, asChild?: boolean }>(
    ({ className, variant, size, asChild, ...props }, ref) => (
        <div
            ref={ref}
            className={cn("flex items-center justify-between p-4 border rounded-lg", className)}
            {...props}
        />
    )
)
Item.displayName = "Item"

const ItemContent = ({ children, className }: { children: React.ReactNode, className?: string }) => <div className={className}>{children}</div>
const ItemTitle = ({ children, className }: { children: React.ReactNode, className?: string }) => <h4 className={cn("font-medium", className)}>{children}</h4>
const ItemDescription = ({ children, className }: { children: React.ReactNode, className?: string }) => <p className={cn("text-sm text-muted-foreground", className)}>{children}</p>
const ItemActions = ({ children }: { children: React.ReactNode }) => <div className="flex items-center gap-2">{children}</div>
const ItemMedia = ({ children, variant }: { children: React.ReactNode, variant?: string }) => <div className="mr-4 text-muted-foreground">{children}</div>

export { Item, ItemContent, ItemTitle, ItemDescription, ItemActions, ItemMedia }
