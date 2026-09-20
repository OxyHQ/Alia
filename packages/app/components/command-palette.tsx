import * as React from "react";
import { Platform } from "react-native";
import { useRouter } from "expo-router";
import { Command, type CommandItem } from "@oxy.so/bloom/command";
import { RiBankCardLine } from "@oxy.so/bloom/icons/RiBankCardLine";
import { RiBookOpenLine } from "@oxy.so/bloom/icons/RiBookOpenLine";
import { RiBookShelfLine } from "@oxy.so/bloom/icons/RiBookShelfLine";
import { RiChat3Line } from "@oxy.so/bloom/icons/RiChat3Line";
import { RiChatNewLine } from "@oxy.so/bloom/icons/RiChatNewLine";
import { RiNotification3Line } from "@oxy.so/bloom/icons/RiNotification3Line";
import { RiSearchLine } from "@oxy.so/bloom/icons/RiSearchLine";
import { RiSettings3Line } from "@oxy.so/bloom/icons/RiSettings3Line";
import { RiSparklingLine } from "@oxy.so/bloom/icons/RiSparklingLine";
import { RiStarFill } from "@oxy.so/bloom/icons/RiStarFill";
import { RiTeamLine } from "@oxy.so/bloom/icons/RiTeamLine";
import { RiTimerLine } from "@oxy.so/bloom/icons/RiTimerLine";
import { useConversations } from "@/lib/hooks/use-conversations";
import { useUIStore } from "@/lib/stores/ui-store";
import { useFavoritesStore } from "@/lib/stores/favorites-store";

/** How many conversations the palette offers before the user types anything. */
const RESTING_CONVERSATIONS = 8;
/** And how many it will search across once they do. */
const SEARCHABLE_CONVERSATIONS = 100;

export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const router = useRouter();
  const { data: conversationsData } = useConversations();
  const toggleShortcutsDialog = useUIStore((s) => s.toggleShortcutsDialog);
  const favoriteIds = useFavoritesStore((state) => state.favoriteConversationIds);

  const conversations = React.useMemo(() => {
    if (!conversationsData?.pages) return [];
    const all = conversationsData.pages.flatMap((page) => page.conversations);
    // At rest the palette is a shortlist of what you were just doing; once
    // there is a query it searches far wider.
    return query.trim()
      ? all.slice(0, SEARCHABLE_CONVERSATIONS)
      : all.slice(0, RESTING_CONVERSATIONS);
  }, [conversationsData, query]);

  const runCommand = React.useCallback(
    (command: () => void) => {
      setOpen(false);
      command();
    },
    []
  );

  const items = React.useMemo<CommandItem[]>(() => {
    const actions: CommandItem[] = [
      {
        id: "new-chat",
        label: "New Chat",
        group: "Actions",
        icon: RiChatNewLine,
        shortcut: "⌘⇧N",
        onSelect: () => router.replace("/(app)"),
      },
      {
        id: "search-library",
        label: "Search Library",
        group: "Actions",
        icon: RiSearchLine,
        onSelect: () => router.push("/(app)/library"),
      },
      {
        id: "agents",
        label: "Agents",
        group: "Navigate",
        icon: RiTeamLine,
        onSelect: () => router.push("/(app)/agents"),
      },
      {
        id: "library",
        label: "Library",
        group: "Navigate",
        icon: RiBookShelfLine,
        onSelect: () => router.push("/(app)/library"),
      },
      {
        id: "automations",
        label: "Automations",
        group: "Navigate",
        icon: RiTimerLine,
        onSelect: () => router.push("/(app)/automations"),
      },
      {
        id: "skills",
        label: "Skills",
        group: "Navigate",
        icon: RiBookOpenLine,
        onSelect: () => router.push("/(app)/skills"),
      },
      {
        id: "settings",
        label: "Settings",
        group: "Settings",
        icon: RiSettings3Line,
        shortcut: "⌘,",
        onSelect: () => router.push("/(app)/settings"),
      },
      {
        id: "billing",
        label: "Billing",
        group: "Settings",
        icon: RiBankCardLine,
        onSelect: () => router.push("/(app)/settings/usage"),
      },
      {
        id: "notifications",
        label: "Notifications",
        group: "Settings",
        icon: RiNotification3Line,
        onSelect: () => router.push("/(app)/notifications"),
      },
      {
        id: "subscribe",
        label: "Upgrade to Pro",
        group: "Settings",
        icon: RiSparklingLine,
        onSelect: () => router.push("/(biglayout)/subscribe"),
      },
    ];

    /**
     * Favourites first, and that is the whole of the ranking.
     *
     * What this replaces was a custom `filter` that took cmdk's own score and
     * multiplied a favourite's by two. The comment on that multiplier recorded
     * the measurement that makes it redundant: cmdk returns ~0.99 for anything
     * containing the query whatever else is in the string, so the boost never
     * expressed a nudge — in practice ANY matching favourite outranked ANY
     * matching non-favourite. Bloom's palette filters without re-ordering, so
     * saying that outright, once, in the order of the array, is the same result
     * with none of the arithmetic. It is also the reason the `value` trick is
     * gone: cmdk matched on a synthesised `"title id"` string that had to be
     * unique, and Bloom matches on the label with `id` kept separately.
     */
    const favouritesFirst = [...conversations].sort((a, b) => {
      const af = favoriteIds.includes(a.id) ? 0 : 1;
      const bf = favoriteIds.includes(b.id) ? 0 : 1;
      return af - bf;
    });

    const group = query.trim() ? "Conversations" : "Recent Conversations";
    const recents: CommandItem[] = favouritesFirst.map((conv) => ({
      id: conv.id,
      label: conv.title ?? "",
      group,
      icon: favoriteIds.includes(conv.id) ? RiStarFill : RiChat3Line,
      onSelect: () => router.push(`/(app)/c/${conv.id}`),
    }));

    return [...actions, ...recents];
  }, [conversations, favoriteIds, query, router]);

  React.useEffect(() => {
    if (Platform.OS !== "web") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      if (e.key === "k" && meta) {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }

      if (e.key === "," && meta) {
        e.preventDefault();
        runCommand(() => router.push("/(app)/settings"));
        return;
      }

      if (e.key === "N" && meta && e.shiftKey) {
        e.preventDefault();
        runCommand(() => router.replace("/(app)"));
        return;
      }

      if (e.key === "/" && meta) {
        e.preventDefault();
        setOpen(false);
        toggleShortcutsDialog();
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [runCommand, router, toggleShortcutsDialog]);

  if (Platform.OS !== "web") return null;

  return (
    <Command
      visible={open}
      onClose={() => setOpen(false)}
      items={items}
      query={query}
      onQueryChange={setQuery}
      placeholder="Type a command or search..."
    />
  );
}
