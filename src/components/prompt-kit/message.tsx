"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Markdown } from "@/components/ui/markdown"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

function Message({
    className,
    children,
    ...props
}: React.ComponentProps<"div">) {
    return (
        <div className={cn("flex gap-3", className)} {...props}>
            {children}
        </div>
    )
}

interface MessageAvatarProps {
    src: string
    alt: string
    fallback?: string
    delayMs?: number
    className?: string
}

function MessageAvatar({
    src,
    alt,
    fallback,
    delayMs,
    className,
}: MessageAvatarProps) {
    return (
        <Avatar className={cn("h-8 w-8 shrink-0", className)}>
            <AvatarImage src={src} alt={alt} />
            {fallback && (
                <AvatarFallback delayMs={delayMs}>{fallback}</AvatarFallback>
            )}
        </Avatar>
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
                <p className="whitespace-pre-wrap leading-[1.75]">{children}</p>
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

export { Message, MessageAvatar, MessageContent, MessageActions, MessageAction }
