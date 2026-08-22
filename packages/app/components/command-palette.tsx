import * as React from "react";
import { Platform } from "react-native";
import { useRouter } from "expo-router";
import {
  Sparkles,
  Settings2,
  BrainCircuit,
  Users,
  Library,
  CloudCog,
  BookOpen,
  Search,
  CreditCard,
  Bell,
  MessageSquarePlus,
  MessageSquare,
  Star,
} from "lucide-react-native";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useConversations } from "@/lib/hooks/use-conversations";
import { useUIStore } from "@/lib/stores/ui-store";
import { useFavoritesStore } from "@/lib/stores/favorites-store";
import { defaultFilter } from "cmdk";

/** How many conversations the palette offers before the user types anything. */
const RESTING_CONVERSATIONS = 8;
/** And how many it will search across once they do. */
const SEARCHABLE_CONVERSATIONS = 100;
/**
 * Multiplies cmdk's own score for a favourite. Measured: the scorer returns
 * ~0.99 for anything that contains the query, whatever else is in the string,
 * so its range is far too narrow for this to read as a nudge — in practice any
 * matching favourite ranks above any matching non-favourite. That is the
 * intent; the multiplier is just how it is expressed.
 */
const FAVORITE_BOOST = 2;

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

  /**
   * cmdk matches against an item's `value`, so the title has to be part of it —
   * with the id appended, because two conversations may share a title and cmdk
   * needs each value to be unique.
   */
  const valueFor = React.useCallback(
    (id: string, title: string | null | undefined) => `${title ?? ""} ${id}`,
    [],
  );

  const favoriteValues = React.useMemo(
    () =>
      new Set(
        conversations
          .filter((conv) => favoriteIds.includes(conv.id))
          .map((conv) => valueFor(conv.id, conv.title)),
      ),
    [conversations, favoriteIds, valueFor],
  );

  const rankFavoritesFirst = React.useCallback(
    (value: string, search: string, keywords?: string[]) => {
      const score = defaultFilter(value, search, keywords);
      return favoriteValues.has(value) ? score * FAVORITE_BOOST : score;
    },
    [favoriteValues],
  );

  const runCommand = React.useCallback(
    (command: () => void) => {
      setOpen(false);
      command();
    },
    []
  );

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
    <CommandDialog open={open} onOpenChange={setOpen} filter={rankFavoritesFirst}>
      <CommandInput
        placeholder="Type a command or search..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => runCommand(() => router.replace("/(app)"))}>
            <MessageSquarePlus size={16} />
            <span>New Chat</span>
            <CommandShortcut>
              <KbdGroup><Kbd>⌘</Kbd><Kbd>⇧</Kbd><Kbd>N</Kbd></KbdGroup>
            </CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/(app)/library"))}>
            <Search size={16} />
            <span>Search Library</span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Navigate">
          <CommandItem onSelect={() => runCommand(() => router.push("/(app)/roles"))}>
            <BrainCircuit size={16} />
            <span>Roles</span>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/(app)/agents"))}>
            <Users size={16} />
            <span>Agents</span>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/(app)/library"))}>
            <Library size={16} />
            <span>Library</span>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/(app)/automations"))}>
            <CloudCog size={16} />
            <span>Automations</span>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/(app)/skills"))}>
            <BookOpen size={16} />
            <span>Skills</span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Settings">
          <CommandItem onSelect={() => runCommand(() => router.push("/(app)/settings"))}>
            <Settings2 size={16} />
            <span>Settings</span>
            <CommandShortcut>
              <KbdGroup><Kbd>⌘</Kbd><Kbd>,</Kbd></KbdGroup>
            </CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/(app)/settings/usage"))}>
            <CreditCard size={16} />
            <span>Billing</span>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/(app)/notifications"))}>
            <Bell size={16} />
            <span>Notifications</span>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/(biglayout)/subscribe"))}>
            <Sparkles size={16} />
            <span>Upgrade to Pro</span>
          </CommandItem>
        </CommandGroup>
        {conversations.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={query.trim() ? "Conversations" : "Recent Conversations"}>
              {conversations.map((conv) => {
                const isFavorite = favoriteIds.includes(conv.id);
                return (
                  <CommandItem
                    key={conv.id}
                    value={valueFor(conv.id, conv.title)}
                    onSelect={() => runCommand(() => router.push(`/(app)/c/${conv.id}`))}
                  >
                    {isFavorite ? (
                      <Star size={16} className="fill-current" />
                    ) : (
                      <MessageSquare size={16} />
                    )}
                    <span className="truncate">{conv.title}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
