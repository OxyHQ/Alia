
"use client";

import { useMemo, useState } from "react";
import { MessageContent } from "@/components/prompt-kit/message";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Copy01Icon,
    BalanceScaleIcon,
    Calendar03Icon,
    Shield01Icon,
    Shield02Icon, // Using Shield02 as ShieldCheck placeholder
    Shield01Icon as Shield03Icon, // Using Shield01 as ShieldAlert placeholder
    ListViewIcon,
    CancelCircleIcon,
    AlertSquareIcon, // AlertTriangle replacement
    CheckmarkCircle01Icon,
    LinkSquare02Icon,
    Image01Icon,
    InformationCircleIcon,
    CheckmarkCircle02Icon,
    AlertCircleIcon,
} from "@hugeicons/core-free-icons";
import { createIcon } from "@/components/ui/hugeicon";

const Copy = createIcon(Copy01Icon)
const Scale = createIcon(BalanceScaleIcon)
const Calendar = createIcon(Calendar03Icon)
const Shield = createIcon(Shield01Icon)
const ShieldCheck = createIcon(Shield02Icon)
const ShieldAlert = createIcon(Shield03Icon)
const List = createIcon(ListViewIcon)
const XCircle = createIcon(CancelCircleIcon)
const AlertTriangle = createIcon(AlertSquareIcon)
const CheckCircle = createIcon(CheckmarkCircle01Icon)
const LinkExternal = createIcon(LinkSquare02Icon)
const ImageIcon = createIcon(Image01Icon)
const Info = createIcon(InformationCircleIcon)
const CheckCircle2 = createIcon(CheckmarkCircle02Icon)
const AlertCircle = createIcon(AlertCircleIcon)

// Aliases for banner usage
const InfoIcon = Info
const CheckCircle2Icon = CheckCircle2
const AlertCircleIconComp = AlertCircle
const AlertTriangleIcon = AlertTriangle
import { cn } from "@/lib/utils";
import { extractBanners } from "@/lib/message-parser";
import { toast } from "sonner";
import { Tool } from "@/components/ui/tool";
import type { UIMessage } from "ai";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Card, CardHeader, CardTitle, CardContent, CardAction, CardDescription, CardFooter } from "@/components/ui/card";

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

            {/* Banners / InfoBoxes using Shadcn Alert */}
            {banners.length > 0 && (
                <div className="space-y-3 w-full">
                    {banners.map((banner, index) => {
                        const Icon = banner.tone === 'danger' ? AlertCircleIcon :
                            banner.tone === 'warning' ? AlertTriangleIcon :
                                banner.tone === 'success' ? CheckCircle2Icon : InfoIcon;
                        return (
                            <Alert key={`banner-${index}`} variant={banner.tone === 'danger' ? 'destructive' : 'default'} className={cn(
                                banner.tone === 'success' && "border-green-500/50 text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/20",
                                banner.tone === 'warning' && "border-amber-500/50 text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20",
                                banner.tone === 'info' && "border-blue-500/50 text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/20",
                            )}>
                                <Icon className="h-4 w-4" />
                                {banner.title && <AlertTitle>{banner.title}</AlertTitle>}
                                <AlertDescription className="text-base leading-[1.75]">
                                    {banner.content}
                                </AlertDescription>
                            </Alert>
                        )
                    })}
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

            {/* Comparison Blocks using Shadcn Card */}
            {comparisons.length > 0 && (
                <div className="space-y-4 w-full">
                    {comparisons.map((comp, index) => (
                        <Card key={`comparison-${index}`} className="overflow-hidden border-none ring-1 ring-border">
                            <CardHeader className="bg-muted/30 border-b py-3">
                                <CardTitle className="flex items-center gap-2 text-base">
                                    <Scale className="h-4 w-4 text-muted-foreground" />
                                    {comp.title}
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="p-0">
                                <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x">
                                    <div className={cn("p-4", comp.left.tone === 'danger' ? 'bg-red-50/20 dark:bg-red-950/10' : 'bg-muted/5')}>
                                        <div className="font-medium text-sm mb-2">{comp.left.title}</div>
                                        <p className="text-[15px] text-muted-foreground leading-[1.75]">{comp.left.content}</p>
                                    </div>
                                    <div className={cn("p-4", comp.right.tone === 'success' ? 'bg-green-50/20 dark:bg-green-950/10' : 'bg-muted/5')}>
                                        <div className="font-medium text-sm mb-2">{comp.right.title}</div>
                                        <p className="text-[15px] text-muted-foreground leading-[1.75]">{comp.right.content}</p>
                                    </div>
                                </div>
                            </CardContent>
                            {comp.conclusion && (
                                <CardFooter className="bg-muted/20 py-3 text-sm font-medium border-t">
                                    {comp.conclusion}
                                </CardFooter>
                            )}
                        </Card>
                    ))}
                </div>
            )}

            {/* Timeline Blocks using Shadcn Card */}
            {timelines.length > 0 && (
                <div className="space-y-4 w-full">
                    {timelines.map((timeline, index) => (
                        <Card key={`timeline-${index}`} className="overflow-hidden border-none ring-1 ring-border">
                            <CardHeader className="bg-muted/30 border-b py-3">
                                <CardTitle className="flex items-center gap-2 text-base">
                                    <Calendar className="h-4 w-4 text-muted-foreground" />
                                    {timeline.title}
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="p-5">
                                <div className="space-y-6 relative before:absolute before:inset-0 before:left-[7px] before:w-0.5 before:bg-border">
                                    {timeline.events.map((event, eventIndex) => (
                                        <div key={eventIndex} className="relative pl-6">
                                            <div className="absolute left-0 top-1.5 h-4 w-4 rounded-full border-2 border-primary bg-background z-10" />
                                            <div className="flex flex-col gap-1">
                                                <Badge variant="secondary" className="text-[10px] w-fit font-bold uppercase tracking-wider">{event.date}</Badge>
                                                <div className="font-semibold text-[15px]">{event.title}</div>
                                                {event.description && <p className="text-sm text-muted-foreground leading-[1.75]">{event.description}</p>}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            {/* Compact List Blocks using Shadcn Card */}
            {compactLists.length > 0 && (
                <div className="space-y-3 w-full">
                    {compactLists.map((list, index) => (
                        <Card key={`compactlist-${index}`} className="overflow-hidden border-none ring-1 ring-border">
                            {list.title && (
                                <CardHeader className="bg-muted/30 border-b py-2 px-4 flex flex-row items-center gap-2">
                                    <List className="h-3.5 w-3.5 text-muted-foreground" />
                                    <CardTitle className="text-sm font-medium">{list.title}</CardTitle>
                                </CardHeader>
                            )}
                            <CardContent className="p-1">
                                {list.items.map((item, itemIndex) => (
                                    <div key={itemIndex} className={cn(
                                        "flex items-start gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                                        item.href ? "hover:bg-muted/50 cursor-pointer" : ""
                                    )}>
                                        {item.image ? (
                                            <div className="h-10 w-10 shrink-0 rounded-md overflow-hidden border bg-muted shadow-sm">
                                                <img src={proxyImage(item.image)} alt="" className="w-full h-full object-cover" />
                                            </div>
                                        ) : (
                                            <div className="h-1.5 w-1.5 rounded-full bg-primary/30 mt-2 shrink-0" />
                                        )}
                                        <div className="flex-1 min-w-0">
                                            {item.href ? (
                                                <a href={item.href} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline block truncate">
                                                    {item.title}
                                                </a>
                                            ) : (
                                                <span className="font-medium block">{item.title}</span>
                                            )}
                                            {item.meta && <span className="text-xs text-muted-foreground block truncate">{item.meta}</span>}
                                        </div>
                                        {item.href && <ExternalLink className="h-3 w-3 shrink-0 mt-1 opacity-30" />}
                                    </div>
                                ))}
                            </CardContent>
                        </Card>
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
