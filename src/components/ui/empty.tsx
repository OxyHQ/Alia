import * as React from "react"
import { cn } from "@/lib/utils"

const Empty = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ className, ...props }, ref) => (
        <div
            ref={ref}
            className={cn("flex flex-col items-center justify-center p-8 text-center border-dashed rounded-lg", className)}
            {...props}
        />
    )
)
Empty.displayName = "Empty"

const EmptyHeader = ({ children }: { children: React.ReactNode }) => <div className="mb-4 space-y-2">{children}</div>
const EmptyMedia = ({ children, variant }: { children: React.ReactNode, variant?: string }) => <div className="flex justify-center mb-4 text-muted-foreground">{children}</div>
const EmptyTitle = ({ children }: { children: React.ReactNode }) => <h3 className="text-lg font-medium">{children}</h3>
const EmptyDescription = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>
const EmptyContent = ({ children }: { children: React.ReactNode }) => <div className="mt-4">{children}</div>

export { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent }
