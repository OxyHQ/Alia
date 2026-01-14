"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

function ChatContainerRoot({
    className,
    children,
    ...props
}: React.ComponentProps<"div">) {
    return (
        <div
            className={cn("flex h-full flex-col overflow-hidden", className)}
            {...props}
        >
            {children}
        </div>
    )
}

function ChatContainerContent({
    className,
    children,
    ...props
}: React.ComponentProps<"div">) {
    return (
        <div
            className={cn("flex-1 overflow-y-auto w-full", className)}
            {...props}
        >
            {children}
        </div>
    )
}

export { ChatContainerRoot, ChatContainerContent }
