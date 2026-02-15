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

export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  const { data: conversationsData } = useConversations();

  const recentConversations = React.useMemo(() => {
    if (!conversationsData?.pages) return [];
    return conversationsData.pages
      .flatMap((page) => page.conversations)
      .slice(0, 8);
  }, [conversationsData]);

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
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [runCommand, router]);

  if (Platform.OS !== "web") return null;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." />
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
          <CommandItem onSelect={() => runCommand(() => router.push("/(app)/billing"))}>
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
        {recentConversations.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent Conversations">
              {recentConversations.map((conv) => (
                <CommandItem
                  key={conv.id}
                  value={`conversation-${conv.id}`}
                  onSelect={() => runCommand(() => router.push(`/(app)/c/${conv.id}`))}
                >
                  <MessageSquare size={16} />
                  <span className="truncate">{conv.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
