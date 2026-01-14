
"use client";

import { useMemo, useState } from "react";
import { MessageContent, MessageActions, MessageAction } from "@/components/prompt-kit/message";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Copy, Scale, Calendar, Shield, ShieldCheck, ShieldAlert, List, XCircle, AlertTriangle, CheckCircle, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { extractBanners } from "@/lib/message-parser";
import { toast } from "sonner"; // Assuming sonner is installed, otherwise use standard alert or console

interface RichMessageProps {
    content: string;
    role: "user" | "assistant" | "data" | "system";
    id?: string;
}

export function RichMessage({ content, role, id }: RichMessageProps) {
    const isAssistant = role === "assistant";

    // Only parse for assistant messages to save perf
    const { banners, comparisons, timelines, credibility, compactLists, body: bodyText } = useMemo(() => {
        if (!isAssistant) return {
            banners: [], comparisons: [], timelines: [], credibility: [], compactLists: [], body: content
        };
        return extractBanners(content);
    }, [content, isAssistant]);

    if (!isAssistant) {
        return (
            <MessageContent className="bg-muted text-foreground max-w-[85%] rounded-2xl px-4 py-2 sm:max-w-[75%]">
                {content}
            </MessageContent>
        );
    }

    return (
        <div className="flex w-full flex-col gap-4">
            {/* Banners / InfoBoxes */}
            {banners.length > 0 && (
                <div className="space-y-2">
                    {banners.map((banner, index) => (
                        <Alert key={`banner-${index}`} variant={banner.tone === 'danger' ? 'destructive' : 'default'} className={cn(
                            banner.tone === 'success' && "border-green-500 text-green-700 bg-green-50 dark:bg-green-950/30",
                            banner.tone === 'warning' && "border-amber-500 text-amber-700 bg-amber-50 dark:bg-amber-950/30",
                            banner.tone === 'info' && "border-blue-500 text-blue-700 bg-blue-50 dark:bg-blue-950/30",
                        )}>
                            <AlertTitle className="font-semibold">{banner.title || "Aviso"}</AlertTitle>
                            <AlertDescription>
                                {banner.content}
                            </AlertDescription>
                        </Alert>
                    ))}
                </div>
            )}

            {/* Comparison Blocks */}
            {comparisons.length > 0 && (
                <div className="space-y-4">
                    {comparisons.map((comp, index) => (
                        <div key={`comparison-${index}`} className="rounded-lg border bg-card text-card-foreground shadow-sm">
                            <div className="flex items-center gap-2 border-b px-4 py-3">
                                <Scale className="h-5 w-5 text-muted-foreground" />
                                <h3 className="font-semibold">{comp.title}</h3>
                            </div>
                            <div className="grid md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x">
                                {/* Left Side */}
                                <div className={cn("p-4",
                                    comp.left.tone === 'danger' ? 'bg-red-50/50 dark:bg-red-950/20' :
                                        comp.left.tone === 'warning' ? 'bg-amber-50/50 dark:bg-amber-950/20' : 'bg-muted/30'
                                )}>
                                    <div className="flex items-center gap-2 mb-2">
                                        {comp.left.tone === 'danger' ? <XCircle className="h-4 w-4 text-red-500" /> :
                                            comp.left.tone === 'warning' ? <AlertTriangle className="h-4 w-4 text-amber-500" /> : null}
                                        <span className="font-medium text-sm truncate max-w-[140px]">{comp.left.title}</span>
                                    </div>
                                    <p className="text-sm text-muted-foreground">{comp.left.content}</p>
                                    {comp.left.source && (
                                        <p className="text-xs text-muted-foreground mt-2 italic">Fuente: {comp.left.source}</p>
                                    )}
                                </div>
                                {/* Right Side */}
                                <div className={cn("p-4",
                                    comp.right.tone === 'success' ? 'bg-green-50/50 dark:bg-green-950/20' : 'bg-muted/30'
                                )}>
                                    <div className="flex items-center gap-2 mb-2">
                                        {comp.right.tone === 'success' ? <CheckCircle className="h-4 w-4 text-green-500" /> : null}
                                        <span className="font-medium text-sm truncate max-w-[140px]">{comp.right.title}</span>
                                    </div>
                                    <p className="text-sm text-muted-foreground">{comp.right.content}</p>
                                    {comp.right.source && (
                                        <p className="text-xs text-muted-foreground mt-2 italic">Fuente: {comp.right.source}</p>
                                    )}
                                </div>
                            </div>
                            {comp.conclusion && (
                                <div className="border-t px-4 py-3 bg-muted/50">
                                    <p className="text-sm font-medium">{comp.conclusion}</p>
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
                            <div className="flex items-center gap-2 border-b px-4 py-3">
                                <Calendar className="h-5 w-5 text-muted-foreground" />
                                <h3 className="font-semibold">{timeline.title}</h3>
                            </div>
                            <div className="p-4">
                                <div className="relative">
                                    <div className="absolute left-[7px] top-2 bottom-2 w-0.5 bg-border" />
                                    <div className="space-y-4">
                                        {timeline.events.map((event, eventIndex) => (
                                            <div key={eventIndex} className="relative pl-6">
                                                <div className="absolute left-0 top-1.5 h-4 w-4 rounded-full border-2 border-primary bg-background" />
                                                <div>
                                                    <div className="flex items-center gap-2 mb-0.5">
                                                        <Badge variant="outline" className="text-xs font-mono">
                                                            {event.date}
                                                        </Badge>
                                                    </div>
                                                    <p className="font-medium text-sm">{event.title}</p>
                                                    {event.description && (
                                                        <p className="text-sm text-muted-foreground mt-0.5">{event.description}</p>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Credibility Blocks */}
            {credibility.length > 0 && (
                <div className="space-y-2">
                    {credibility.map((cred, index) => {
                        const getCredibilityColor = (level: number) => {
                            if (level === 1 || level === 2) return "text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800";
                            if (level === 3) return "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800";
                            if (level === 4) return "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800";
                            return "text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-950/30 border-gray-200 dark:border-gray-800";
                        };

                        const getCredibilityIcon = (level: number) => {
                            if (level === 1 || level === 2) return <ShieldCheck className="h-4 w-4" />;
                            if (level === 3) return <Shield className="h-4 w-4" />;
                            return <ShieldAlert className="h-4 w-4" />;
                        };

                        const getCredibilityLabel = (level: number) => {
                            if (level === 1) return "Máxima Credibilidad";
                            if (level === 2) return "Alta Credibilidad";
                            if (level === 3) return "Credibilidad Media";
                            if (level === 4) return "Requiere Verificación";
                            return "Contenido Subjetivo";
                        };

                        return (
                            <div key={`credibility-${index}`} className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", getCredibilityColor(cred.level))}>
                                {getCredibilityIcon(cred.level)}
                                <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="font-semibold">Nivel {cred.level}:</span>
                                        <span>{getCredibilityLabel(cred.level)}</span>
                                    </div>
                                    <p className="text-xs opacity-90 mt-0.5">{cred.source}</p>
                                    {cred.warning && (
                                        <p className="text-xs opacity-80 mt-1 italic">⚠️ {cred.warning}</p>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Compact List Blocks */}
            {compactLists.length > 0 && (
                <div className="space-y-3">
                    {compactLists.map((list, index) => (
                        <div key={`compactlist-${index}`} className="rounded-lg border bg-card text-card-foreground shadow-sm">
                            {list.title && (
                                <div className="flex items-center gap-2 border-b px-4 py-2.5">
                                    <List className="h-4 w-4 text-muted-foreground" />
                                    <h4 className="font-medium text-sm">{list.title}</h4>
                                </div>
                            )}
                            <div className="p-3">
                                <div className="grid gap-1.5">
                                    {list.items.map((item, itemIndex) => (
                                        <div key={itemIndex} className={cn("flex items-center gap-2 rounded px-2 py-1.5 text-sm", item.href ? "hover:bg-muted/50 transition-colors" : "")}>
                                            <div className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                                            {item.href ? (
                                                <a href={item.href} target="_blank" rel="noopener noreferrer" className="flex-1 hover:underline flex items-center gap-1">
                                                    {item.title}
                                                    <ExternalLink className="h-3 w-3 opacity-50" />
                                                </a>
                                            ) : (
                                                <span className="flex-1">{item.title}</span>
                                            )}
                                            {item.meta && (
                                                <Badge variant="outline" className="text-xs shrink-0">
                                                    {item.meta}
                                                </Badge>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Main Body Text */}
            <MessageContent
                className="text-foreground prose dark:prose-invert w-full flex-1 rounded-lg bg-transparent p-0"
                markdown
            >
                {bodyText}
            </MessageContent>
        </div>
    );
}
