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
import { useConversations } from "@/features/chat/runtime/use-conversations";
import { useTranslation } from "@/shared/i18n/use-translation";
import { useUIStore } from "@/features/chat/runtime/ui-store";
import { useFavoritesStore } from "@/features/projects/runtime/favorites-store";

/** How many conversations the palette offers before the user types anything. */
const RESTING_CONVERSATIONS = 8;
/** And how many it will search across once they do. */
const SEARCHABLE_CONVERSATIONS = 100;

export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const router = useRouter();
  const { t } = useTranslation();
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
        label: t("dialogs.commandPalette.newChat"),
        group: t("dialogs.commandPalette.groupActions"),
        icon: RiChatNewLine,
        shortcut: "⌘⇧N",
        onSelect: () => router.replace("/(app)"),
      },
      {
        id: "search-library",
        label: t("dialogs.commandPalette.searchLibrary"),
        group: t("dialogs.commandPalette.groupActions"),
        icon: RiSearchLine,
        onSelect: () => router.push("/(app)/library"),
      },
      {
        id: "agents",
        label: t("dialogs.commandPalette.agents"),
        group: t("dialogs.commandPalette.groupNavigate"),
        icon: RiTeamLine,
        onSelect: () => router.push("/(app)/agents"),
      },
      {
        id: "library",
        label: t("dialogs.commandPalette.library"),
        group: t("dialogs.commandPalette.groupNavigate"),
        icon: RiBookShelfLine,
        onSelect: () => router.push("/(app)/library"),
      },
      {
        id: "automations",
        label: t("dialogs.commandPalette.automations"),
        group: t("dialogs.commandPalette.groupNavigate"),
        icon: RiTimerLine,
        onSelect: () => router.push("/(app)/automations"),
      },
      {
        id: "skills",
        label: t("dialogs.commandPalette.skills"),
        group: t("dialogs.commandPalette.groupNavigate"),
        icon: RiBookOpenLine,
        onSelect: () => router.push("/(app)/skills"),
      },
      {
        id: "settings",
        label: t("dialogs.commandPalette.settings"),
        group: t("dialogs.commandPalette.groupSettings"),
        icon: RiSettings3Line,
        shortcut: "⌘,",
        onSelect: () => router.push("/(app)/settings"),
      },
      {
        id: "billing",
        label: t("dialogs.commandPalette.billing"),
        group: t("dialogs.commandPalette.groupSettings"),
        icon: RiBankCardLine,
        onSelect: () => router.push("/(app)/settings/usage"),
      },
      {
        id: "notifications",
        label: t("dialogs.commandPalette.notifications"),
        group: t("dialogs.commandPalette.groupSettings"),
        icon: RiNotification3Line,
        onSelect: () => router.push("/(app)/notifications"),
      },
      {
        id: "subscribe",
        label: t("dialogs.commandPalette.upgrade"),
        group: t("dialogs.commandPalette.groupSettings"),
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

    const group = t(
      query.trim()
        ? "dialogs.commandPalette.groupConversations"
        : "dialogs.commandPalette.groupRecentConversations",
    );
    const recents: CommandItem[] = favouritesFirst.map((conv) => ({
      id: conv.id,
      label: conv.title ?? "",
      group,
      icon: favoriteIds.includes(conv.id) ? RiStarFill : RiChat3Line,
      onSelect: () => router.push(`/(app)/c/${conv.id}`),
    }));

    return [...actions, ...recents];
  }, [conversations, favoriteIds, query, router, t]);

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
      placeholder={t("dialogs.commandPalette.placeholder")}
      emptyText={t("dialogs.commandPalette.empty")}
    />
  );
}
