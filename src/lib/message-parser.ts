
// Logic extracted from Athina/webapp to parse custom LLM blocks
import type { UIMessage } from "ai";

export type BannerBlock = {
    tone: "info" | "success" | "warning" | "danger";
    title?: string;
    content: string;
};

export type ComparisonBlock = {
    title: string;
    left: { title: string; content: string; source?: string; tone: "danger" | "warning" | "info" };
    right: { title: string; content: string; source?: string; tone: "success" | "info" };
    conclusion?: string;
};

export type TimelineBlock = {
    title: string;
    events: Array<{ date: string; title: string; description?: string }>;
};

export type CredibilityBlock = {
    level: 1 | 2 | 3 | 4 | 5;
    source: string;
    warning?: string;
};

export type CompactListBlock = {
    title?: string;
    items: Array<{ title: string; href?: string; meta?: string }>;
};

const BANNER_REGEX = /\[BANNER(?:\s+type="([^"]+)")?(?:\s+title="([^"]*)")?\]([\s\S]*?)\[\/BANNER\]/gi;
const INFOBOX_REGEX = /\[INFOBOX(?:\s+type="([^"]+)")?(?:\s+title="([^"]*)")?\]([\s\S]*?)\[\/INFOBOX\]/gi;
const COMPARISON_REGEX = /\[COMPARISON(?:\s+title="([^"]*)")?\]([\s\S]*?)\[\/COMPARISON\]/gi;
const TIMELINE_REGEX = /\[TIMELINE(?:\s+title="([^"]*)")?\]([\s\S]*?)\[\/TIMELINE\]/gi;
const CREDIBILITY_REGEX = /\[CREDIBILITY\s+level="([1-5])"\s+source="([^"]+)"(?:\s+warning="([^"]*)")?\s*\/\]/gi;
const COMPACTLIST_REGEX = /\[COMPACTLIST(?:\s+title="([^"]*)")?\]([\s\S]*?)\[\/COMPACTLIST\]/gi;

export function extractBanners(text: string): { 
    banners: BannerBlock[]; 
    comparisons: ComparisonBlock[]; 
    timelines: TimelineBlock[]; 
    credibility: CredibilityBlock[]; 
    compactLists: CompactListBlock[]; 
    body: string 
} {
    const banners: BannerBlock[] = [];
    const comparisons: ComparisonBlock[] = [];
    const timelines: TimelineBlock[] = [];
    const credibility: CredibilityBlock[] = [];
    const compactLists: CompactListBlock[] = [];
    let cleanedBody = text;

    const matches = [
        ...text.matchAll(BANNER_REGEX),
        ...text.matchAll(INFOBOX_REGEX),
    ];

    matches.forEach((match) => {
        const rawType = (match[1] || "").toLowerCase().trim();
        const type: BannerBlock["tone"] = rawType === "success" || rawType === "warning" || rawType === "danger" ? rawType : "info";
        const title = (match[2] || "").trim() || undefined;
        const content = (match[3] || "").trim() || "";

        if (content) {
            banners.push({ tone: type, title, content });
            cleanedBody = cleanedBody.replace(match[0], "");
        }
    });

    // Extract COMPARISON blocks
    const compMatches = [...text.matchAll(COMPARISON_REGEX)];
    compMatches.forEach((match) => {
        const title = (match[1] || "Comparación").trim();
        const inner = (match[2] || "").trim();

        // Parse LEFT, RIGHT, CONCLUSION
        const leftMatch = inner.match(/LEFT:\s*(\{[\s\S]*?\})/i);
        const rightMatch = inner.match(/RIGHT:\s*(\{[\s\S]*?\})/i);
        const conclusionMatch = inner.match(/CONCLUSION:\s*(.+?)(?:\n|$)/i);

        try {
            const left = leftMatch ? JSON.parse(leftMatch[1]) : null;
            const right = rightMatch ? JSON.parse(rightMatch[1]) : null;

            if (left && right) {
                comparisons.push({
                    title,
                    left: { ...left, tone: left.tone || "danger" },
                    right: { ...right, tone: right.tone || "success" },
                    conclusion: conclusionMatch ? conclusionMatch[1].trim() : undefined,
                });
            }
        } catch {
            // JSON parse failed, skip this comparison
        }
        cleanedBody = cleanedBody.replace(match[0], "");
    });

    // Extract TIMELINE blocks
    const timeMatches = [...text.matchAll(TIMELINE_REGEX)];
    timeMatches.forEach((match) => {
        const title = (match[1] || "Cronología").trim();
        const inner = (match[2] || "").trim();

        // Parse event lines: - {"date": "...", "title": "...", "description": "..."}
        const eventLines = inner.match(/-\s*\{[\s\S]*?\}/g) || [];
        const events: Array<{ date: string; title: string; description?: string }> = [];

        eventLines.forEach((line) => {
            const jsonMatch = line.match(/\{[\s\S]*?\}/);
            if (jsonMatch) {
                try {
                    const event = JSON.parse(jsonMatch[0]);
                    if (event.date && event.title) {
                        events.push(event);
                    }
                } catch {
                    // JSON parse failed, skip this event
                }
            }
        });

        if (events.length > 0) {
            timelines.push({ title, events });
        }
        cleanedBody = cleanedBody.replace(match[0], "");
    });

    // Extract CREDIBILITY blocks
    const credMatches = [...text.matchAll(CREDIBILITY_REGEX)];
    credMatches.forEach((match) => {
        const level = parseInt(match[1]) as 1 | 2 | 3 | 4 | 5;
        const source = match[2].trim();
        const warning = match[3] ? match[3].trim() : undefined;

        credibility.push({ level, source, warning });
        cleanedBody = cleanedBody.replace(match[0], "");
    });

    // Extract COMPACTLIST blocks
    const listMatches = [...text.matchAll(COMPACTLIST_REGEX)];
    listMatches.forEach((match) => {
        const title = match[1] ? match[1].trim() : undefined;
        const inner = (match[2] || "").trim();

        // Parse list items: - {"title": "...", "href": "...", "meta": "..."}  or  - Simple text
        const itemLines = inner.match(/-\s*(.+)$/gm) || [];
        const items: Array<{ title: string; href?: string; meta?: string }> = [];

        itemLines.forEach((line) => {
            const content = line.replace(/^-\s*/, "").trim();

            // Try to parse as JSON first
            if (content.startsWith("{")) {
                try {
                    const parsed = JSON.parse(content);
                    items.push({
                        title: parsed.title || content,
                        href: parsed.href,
                        meta: parsed.meta,
                    });
                } catch {
                    // Not valid JSON, treat as plain text
                    items.push({ title: content });
                }
            } else {
                items.push({ title: content });
            }
        });

        if (items.length > 0) {
            compactLists.push({ title, items });
        }
        cleanedBody = cleanedBody.replace(match[0], "");
    });

    cleanedBody = cleanedBody.replace(/\n{3,}/g, "\n\n").trim();

    return { banners, comparisons, timelines, credibility, compactLists, body: cleanedBody };
}
