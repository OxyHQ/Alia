
"use client";

import { useMemo, useState } from "react";
import { MessageContent } from "@/components/prompt-kit/message";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, Scale, Calendar, Shield, ShieldCheck, ShieldAlert, List, XCircle, AlertTriangle, CheckCircle, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { extractBanners } from "@/lib/message-parser";
import { toast } from "sonner";
import { Tool } from "@/components/ui/tool";
import type { UIMessage } from "ai";

interface RichMessageProps {
    content: string;
    role: "user" | "assistant" | "data" | "system";
    id?: string;
    message?: UIMessage; // Pass the whole message for tool parts
}

export function RichMessage({ content, role, id, message }: RichMessageProps) {
    const isAssistant = role === "assistant";

    // Extract blocks from text content
    const { banners, comparisons, timelines, credibility, compactLists, body: bodyText } = useMemo(() => {
        if (!isAssistant) return {
            banners: [], comparisons: [], timelines: [], credibility: [], compactLists: [], body: content
        };
        return extractBanners(content);
    }, [content, isAssistant]);

    // Extract tool calls from message parts
    const toolCalls = useMemo(() => {
        if (!message || !message.parts) return [];
        return message.parts
            .filter((part) => typeof part.type === "string" && part.type.startsWith("tool-"))
            .map((part: any) => {
                const toolName = part.type.replace("tool-", "");
                return {
                    type: toolName,
                    state: part.state || "input-available",
                    input: part.input || {},
                    output: part.output,
                    toolCallId: part.toolCallId,
                    errorText: part.errorText,
                };
            });
    }, [message]);

    if (!isAssistant) {
        return (
            <div className="flex w-full justify-end">
                <div className="bg-primary text-primary-foreground max-w-[85%] rounded-2xl px-4 py-2 sm:max-w-[75%] shadow-sm">
                    {content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex w-full flex-col gap-4">
            {/* Tool Calls */}
            {toolCalls.length > 0 && (
                <div className="space-y-2">
                    {toolCalls.map((toolCall, index) => (
                        <Tool
                            key={toolCall.toolCallId || index}
                            toolPart={toolCall as any}
                            defaultOpen={false}
                        />
                    ))}
                </div>
            )}

            {/* Banners / InfoBoxes */}
            {banners.length > 0 && (
                <div className="space-y-2">
                    {banners.map((banner, index) => (
                        <div key={`banner-${index}`} className={cn(
                            "rounded-lg border p-4 shadow-sm",
                            banner.tone === 'danger' && "border-red-500 text-red-700 bg-red-50 dark:bg-red-950/30",
                            banner.tone === 'success' && "border-green-500 text-green-700 bg-green-50 dark:bg-green-950/30",
                            banner.tone === 'warning' && "border-amber-500 text-amber-700 bg-amber-50 dark:bg-amber-950/30",
                            banner.tone === 'info' && "border-blue-500 text-blue-700 bg-blue-50 dark:bg-blue-950/30",
                        )}>
                            <div className="flex items-center gap-2 mb-1">
                                <h4 className="font-semibold">{banner.title || "Aviso"}</h4>
                            </div>
                            <p className="text-sm opacity-90">{banner.content}</p>
                        </div>
                    ))}
                </div>
            )}

            {/* Comparison Blocks */}
            {comparisons.length > 0 && (
                <div className="space-y-4">
                    {comparisons.map((comp, index) => (
                        <div key={`comparison-${index}`} className="rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden">
                            <div className="flex items-center gap-2 border-b px-4 py-3 bg-muted/20">
                                <Scale className="h-5 w-5 text-muted-foreground" />
                                <h3 className="font-semibold">{comp.title}</h3>
                            </div>
                            <div className="grid md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x">
                                <div className={cn("p-4", comp.left.tone === 'danger' ? 'bg-red-50/30' : 'bg-muted/10')}>
                                    <div className="flex items-center gap-2 mb-2 font-medium">
                                        <span className="text-sm">{comp.left.title}</span>
                                    </div>
                                    <p className="text-sm text-muted-foreground">{comp.left.content}</p>
                                </div>
                                <div className={cn("p-4", comp.right.tone === 'success' ? 'bg-green-50/30' : 'bg-muted/10')}>
                                    <div className="flex items-center gap-2 mb-2 font-medium">
                                        <span className="text-sm">{comp.right.title}</span>
                                    </div>
                                    <p className="text-sm text-muted-foreground">{comp.right.content}</p>
                                </div>
                            </div>
                            {comp.conclusion && (
                                <div className="border-t px-4 py-3 bg-muted/20 text-sm font-medium">
                                    {comp.conclusion}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* Timeline Blocks */}
            {timelines.length > 0 && (
                <div className="space-y-4">
                    {timelines.map((timeline, index) => (
                        <div key={`timeline-${index}`} className="rounded-lg border bg-card text-card-foreground shadow-sm">
                            <div className="flex items-center gap-2 border-b px-4 py-3 bg-muted/20">
                                <Calendar className="h-5 w-5 text-muted-foreground" />
                                <h3 className="font-semibold">{timeline.title}</h3>
                            </div>
                            <div className="p-4">
                                <div className="space-y-4 relative before:absolute before:inset-0 before:left-[7px] before:w-0.5 before:bg-border">
                                    {timeline.events.map((event, eventIndex) => (
                                        <div key={eventIndex} className="relative pl-6">
                                            <div className="absolute left-0 top-1.5 h-4 w-4 rounded-full border-2 border-primary bg-background" />
                                            <div className="flex flex-col">
                                                <Badge variant="outline" className="text-[10px] w-fit mb-1">{event.date}</Badge>
                                                <span className="font-medium text-sm">{event.title}</span>
                                                {event.description && <p className="text-xs text-muted-foreground mt-0.5">{event.description}</p>}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Compact List Blocks */}
            {compactLists.length > 0 && (
                <div className="space-y-3">
                    {compactLists.map((list, index) => (
                        <div key={`compactlist-${index}`} className="rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden">
                            {list.title && (
                                <div className="flex items-center gap-2 border-b px-4 py-2 bg-muted/20">
                                    <List className="h-4 w-4 text-muted-foreground" />
                                    <h4 className="font-medium text-sm">{list.title}</h4>
                                </div>
                            )}
                            <div className="p-2 space-y-1">
                                {list.items.map((item, itemIndex) => (
                                    <div key={itemIndex} className={cn(
                                        "flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors",
                                        item.href ? "hover:bg-muted/50 cursor-pointer text-primary" : "text-foreground"
                                    )}>
                                        <div className="h-1 w-1 rounded-full bg-primary/50 shrink-0" />
                                        {item.href ? (
                                            <a href={item.href} target="_blank" rel="noopener noreferrer" className="flex-1 hover:underline truncate">
                                                {item.title}
                                            </a>
                                        ) : (
                                            <span className="flex-1 truncate">{item.title}</span>
                                        )}
                                        {item.meta && <Badge variant="secondary" className="text-[10px] py-0">{item.meta}</Badge>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Main Body Text */}
            {bodyText && (
                <MessageContent
                    className="text-foreground prose dark:prose-invert max-w-none bg-transparent p-0"
                    markdown
                >
                    {bodyText}
                </MessageContent>
            )}

            {/* Credibility Footer */}
            {credibility.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                    {credibility.map((cred, index) => (
                        <div key={`cred-${index}`} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/30 border text-[10px]">
                            {cred.level <= 2 ? <ShieldCheck className="h-3 w-3 text-green-500" /> : <Shield className="h-3 w-3 text-amber-500" />}
                            <span className="font-medium">Nivel {cred.level}</span>
                            <span className="opacity-70">|</span>
                            <span className="truncate max-w-[150px]">{cred.source}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
