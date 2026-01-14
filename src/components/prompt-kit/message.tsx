"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Markdown } from "@/components/ui/markdown"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

function Message({
    className,
    children,
    ...props
}: React.ComponentProps<"div">) {
    return (
        <div className={cn("flex flex-col gap-2", className)} {...props}>
            {children}
        </div>
    )
}

interface MessageContentProps extends React.ComponentProps<"div"> {
    markdown?: boolean
    children: string
}

function MessageContent({
    className,
    markdown,
    children,
    ...props
}: MessageContentProps) {
    return (
        <div className={cn(className)} {...props}>
            {markdown ? (
                <Markdown>{children}</Markdown>
            ) : (
                <p className="whitespace-pre-wrap leading-relaxed">{children}</p>
            )}
        </div>
    )
}

function MessageActions({
    className,
    children,
    ...props
}: React.ComponentProps<"div">) {
    return (
        <div className={cn("flex items-center gap-1", className)} {...props}>
            {children}
        </div>
    )
}

interface MessageActionProps extends React.ComponentProps<typeof Tooltip> {
    tooltip: string
    children: React.ReactNode
}

function MessageAction({
    tooltip,
    children,
    ...props
}: MessageActionProps) {
    return (
        <Tooltip {...props}>
            <TooltipTrigger asChild>
                {children}
            </TooltipTrigger>
            <TooltipContent side="top">
                {tooltip}
            </TooltipContent>
        </Tooltip>
    )
}

export { Message, MessageContent, MessageActions, MessageAction }
