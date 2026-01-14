
"use client";

import { useMemo, useState } from "react";
import { MessageContent } from "@/components/prompt-kit/message";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, Scale, Calendar, Shield, ShieldCheck, ShieldAlert, List, XCircle, AlertTriangle, CheckCircle, ExternalLink, Image as ImageIcon } from "lucide-react";
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
    const { banners, comparisons, timelines, credibility, compactLists, images, body: bodyText } = useMemo(() => {
        if (!isAssistant) return {
            banners: [], comparisons: [], timelines: [], credibility: [], compactLists: [], images: [], body: content
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

    // Helper to proxy and cache external images
    const proxyImage = (url: string) => {
        if (!url) return "";
        if (url.startsWith('data:') || url.startsWith('/') || url.includes('localhost')) return url;
        return `/api/proxy/image?url=${encodeURIComponent(url)}`;
    };

    if (!isAssistant) {
        return (
            <div className="flex w-full justify-end">
                <div className="bg-primary text-primary-foreground max-w-[85%] rounded-2xl px-4 py-2 sm:max-w-[75%] shadow-sm break-words whitespace-pre-wrap">
                    {content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex w-full flex-col gap-4 overflow-hidden max-w-full">
            {/* Tool Calls */}
            {toolCalls.length > 0 && (
                <div className="space-y-2 w-full">
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
                <div className="space-y-2 w-full">
                    {banners.map((banner, index) => (
                        <div key={`banner-${index}`} className={cn(
                            "rounded-lg border p-4 shadow-sm w-full break-words",
                            banner.tone === 'danger' && "border-red-500 text-red-700 bg-red-50 dark:bg-red-950/30",
                            banner.tone === 'success' && "border-green-500 text-green-700 bg-green-50 dark:bg-green-950/30",
                            banner.tone === 'warning' && "border-amber-500 text-amber-700 bg-amber-50 dark:bg-amber-950/30",
                            banner.tone === 'info' && "border-blue-500 text-blue-700 bg-blue-50 dark:bg-blue-950/30",
                        )}>
                            <div className="flex items-center gap-2 mb-1">
                                <h4 className="font-semibold leading-tight">{banner.title || "Aviso"}</h4>
                            </div>
                            <p className="text-base opacity-90 whitespace-pre-wrap leading-[1.75]">{banner.content}</p>
                        </div>
                    ))}
                </div>
            )}

            {/* Images Block [IMAGE] */}
            {images.length > 0 && (
                <div className="space-y-4 w-full">
                    {images.map((img, index) => (
                        <div key={`img-${index}`} className="flex flex-col gap-2 w-full">
                            {img.title && <h4 className="font-medium text-sm px-1">{img.title}</h4>}
                            <div className="relative rounded-xl overflow-hidden border shadow-sm group bg-muted">
                                <img
                                    src={proxyImage(img.url)}
                                    alt={img.title || "Imagen de Alia"}
                                    className="w-full h-auto object-contain max-h-[500px] transition-transform duration-300 group-hover:scale-[1.01]"
                                />
                            </div>
                            {img.caption && <p className="text-xs text-muted-foreground px-1 italic">{img.caption}</p>}
                        </div>
                    ))}
                </div>
            )}

            {/* Comparison Blocks */}
            {comparisons.length > 0 && (
                <div className="space-y-4 w-full">
                    {comparisons.map((comp, index) => (
                        <div key={`comparison-${index}`} className="rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden w-full">
                            <div className="flex items-center gap-2 border-b px-4 py-3 bg-muted/20">
                                <Scale className="h-5 w-5 text-muted-foreground shrink-0" />
                                <h3 className="font-semibold leading-tight break-words">{comp.title}</h3>
                            </div>
                            <div className="grid md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x">
                                <div className={cn("p-4 min-w-0", comp.left.tone === 'danger' ? 'bg-red-50/30' : 'bg-muted/10')}>
                                    <div className="flex items-center gap-2 mb-2 font-medium">
                                        <span className="text-sm break-words leading-tight">{comp.left.title}</span>
                                    </div>
                                    <p className="text-[15px] text-muted-foreground whitespace-pre-wrap leading-[1.75]">{comp.left.content}</p>
                                </div>
                                <div className={cn("p-4 min-w-0", comp.right.tone === 'success' ? 'bg-green-50/30' : 'bg-muted/10')}>
                                    <div className="flex items-center gap-2 mb-2 font-medium">
                                        <span className="text-sm break-words leading-tight">{comp.right.title}</span>
                                    </div>
                                    <p className="text-[15px] text-muted-foreground whitespace-pre-wrap leading-[1.75]">{comp.right.content}</p>
                                </div>
                            </div>
                            {comp.conclusion && (
                                <div className="border-t px-4 py-3 bg-muted/20 text-sm font-medium whitespace-pre-wrap">
                                    {comp.conclusion}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* Timeline Blocks */}
            {timelines.length > 0 && (
                <div className="space-y-4 w-full">
                    {timelines.map((timeline, index) => (
                        <div key={`timeline-${index}`} className="rounded-lg border bg-card text-card-foreground shadow-sm w-full overflow-hidden">
                            <div className="flex items-center gap-2 border-b px-4 py-3 bg-muted/20">
                                <Calendar className="h-5 w-5 text-muted-foreground shrink-0" />
                                <h3 className="font-semibold leading-tight break-words">{timeline.title}</h3>
                            </div>
                            <div className="p-4">
                                <div className="space-y-6 relative before:absolute before:inset-0 before:left-[7px] before:w-0.5 before:bg-border">
                                    {timeline.events.map((event, eventIndex) => (
                                        <div key={eventIndex} className="relative pl-6">
                                            <div className="absolute left-0 top-1.5 h-4 w-4 rounded-full border-2 border-primary bg-background z-10" />
                                            <div className="flex flex-col min-w-0 gap-1">
                                                <Badge variant="outline" className="text-xs w-fit shrink-0">{event.date}</Badge>
                                                <span className="font-medium text-[15px] leading-tight break-words">{event.title}</span>
                                                {event.description && <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-[1.75]">{event.description}</p>}
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
                <div className="space-y-3 w-full">
                    {compactLists.map((list, index) => (
                        <div key={`compactlist-${index}`} className="rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden w-full">
                            {list.title && (
                                <div className="flex items-center gap-2 border-b px-4 py-2 bg-muted/20">
                                    <List className="h-4 w-4 text-muted-foreground shrink-0" />
                                    <h4 className="font-medium text-sm truncate">{list.title}</h4>
                                </div>
                            )}
                            <div className="p-1 space-y-0.5">
                                {list.items.map((item, itemIndex) => (
                                    <div key={itemIndex} className={cn(
                                        "flex items-start gap-3 rounded-md px-3 py-2 text-sm transition-colors w-full min-w-0",
                                        item.href ? "hover:bg-muted/50 cursor-pointer text-primary" : "text-foreground"
                                    )}>
                                        {item.image ? (
                                            <div className="h-10 w-10 shrink-0 rounded-md overflow-hidden border bg-muted mt-0.5 shadow-sm">
                                                <img src={proxyImage(item.image)} alt="" className="w-full h-full object-cover" />
                                            </div>
                                        ) : (
                                            <div className="h-1.5 w-1.5 rounded-full bg-primary/40 shrink-0 mt-2 ml-1" />
                                        )}
                                        <div className="flex-1 flex flex-col min-w-0 gap-0.5">
                                            {item.href ? (
                                                <a href={item.href} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline break-words">
                                                    {item.title}
                                                </a>
                                            ) : (
                                                <span className="font-medium break-words">{item.title}</span>
                                            )}
                                            {item.meta && <span className="text-xs text-muted-foreground/80">{item.meta}</span>}
                                        </div>
                                        {item.href && <ExternalLink className="h-3 w-3 shrink-0 mt-1 opacity-40" />}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Main Body Text */}
            {bodyText && (
                <div className="w-full min-w-0 overflow-hidden px-1">
                    <MessageContent
                        className="text-foreground prose dark:prose-invert max-w-none bg-transparent p-0 break-words"
                        markdown
                    >
                        {bodyText}
                    </MessageContent>
                </div>
            )}


            {/* Credibility Footer */}
            {credibility.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2 w-full">
                    {credibility.map((cred, index) => (
                        <div key={`cred-${index}`} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/30 border text-xs max-w-full">
                            {cred.level <= 2 ? <ShieldCheck className="h-3 w-3 text-green-500 shrink-0" /> : <Shield className="h-3 w-3 text-amber-500 shrink-0" />}
                            <span className="font-medium shrink-0">Nivel {cred.level}</span>
                            <span className="opacity-70 shrink-0">|</span>
                            <span className="truncate max-w-[250px]">{cred.source}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
