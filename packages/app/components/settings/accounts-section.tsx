import { View, Pressable, ActivityIndicator } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useConnectedAccounts, type ConnectedAccount } from "@/lib/hooks/use-connected-accounts";
import { toast } from "@oxyhq/bloom/toast";
import { confirm } from "@oxyhq/bloom/alert-dialog";
import { SettingsListGroup, SettingsListItem } from "@oxyhq/bloom/settings-list";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import {
  Smartphone,
  Plus,
  Wifi,
  WifiOff,
  AlertCircle,
  Trash2,
} from "lucide-react-native";

const PLATFORM_CONFIG: Record<string, { label: string; color: string }> = {
  whatsapp: { label: "WhatsApp", color: "#25D366" },
  telegram: { label: "Telegram", color: "#0088CC" },
  signal: { label: "Signal", color: "#3A76F0" },
  gmail: { label: "Gmail", color: "#EA4335" },
};

const CONNECT_PLATFORMS = [
  { id: "whatsapp", label: "WhatsApp" },
  { id: "telegram", label: "Telegram" },
  { id: "signal", label: "Signal" },
  { id: "gmail", label: "Gmail" },
];

function StatusBadge({ status }: { status: ConnectedAccount["status"] }) {
  const config = {
    connected: { label: "Connected", bg: "bg-green-500/10", text: "text-green-600" },
    connecting: { label: "Connecting", bg: "bg-yellow-500/10", text: "text-yellow-600" },
    disconnected: { label: "Disconnected", bg: "bg-gray-500/10", text: "text-gray-500" },
    error: { label: "Error", bg: "bg-red-500/10", text: "text-red-600" },
    expired: { label: "Expired", bg: "bg-gray-500/10", text: "text-gray-500" },
  }[status] ?? { label: status, bg: "bg-gray-500/10", text: "text-gray-500" };

  return (
    <View className={`px-2 py-0.5 rounded-full ${config.bg}`}>
      <Text className={`text-[10px] font-medium ${config.text}`}>{config.label}</Text>
    </View>
  );
}

function AccountRow({
  account,
  onDisconnect,
}: {
  account: ConnectedAccount;
  onDisconnect: (id: string) => void;
}) {
  const platform = PLATFORM_CONFIG[account.platform];
  const color = platform?.color ?? "#6b7280";
  const label = platform?.label ?? account.platform;
  const identifier = account.phoneNumber || account.email || account.accountId;

  return (
    <SettingsListItem
      icon={<Smartphone size={18} color={color} />}
      title={label}
      description={identifier}
      showChevron={false}
      rightElement={
        <View className="flex-row items-center gap-1">
          <StatusBadge status={account.status} />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            accessibilityLabel={`Disconnect ${label}`}
            onPress={() => onDisconnect(account._id)}
          >
            <Trash2 size={15} className="text-destructive" />
          </Button>
        </View>
      }
    />
  );
}

export function AccountsSection() {
  const { accounts, loading, connect, disconnect, remove } = useConnectedAccounts();
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async (platformId: string) => {
    setConnecting(true);
    try {
      await connect(platformId);
      toast.success(`Started connecting ${PLATFORM_CONFIG[platformId]?.label ?? platformId}`);
    } catch (err) {
      console.error("Failed to connect account:", err);
      toast.error("Failed to connect account");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    const ok = await confirm({
      title: "Disconnect Account",
      description: "Are you sure you want to disconnect this account? You can reconnect it anytime.",
      confirmLabel: "Disconnect",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove(accountId);
      toast.success("Account disconnected");
    } catch (err) {
      console.error("Failed to disconnect account:", err);
      toast.error("Failed to disconnect account");
    }
  };

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center py-12">
        <ActivityIndicator size="small" />
      </View>
    );
  }

  return (
    <View className="gap-4">
      <Text className="text-xs text-muted-foreground">
        Link your messaging accounts so Alia can read and respond on your behalf.
      </Text>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <Pressable>
            <Button disabled={connecting}>
              <View className="flex-row items-center gap-1.5">
                <Plus size={16} color="white" />
                <Text className="text-sm font-medium text-primary-foreground">
                  {connecting ? "Connecting..." : "Connect Account"}
                </Text>
              </View>
            </Button>
          </Pressable>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          {CONNECT_PLATFORMS.map((p) => (
            <DropdownMenu.Item key={p.id} onSelect={() => handleConnect(p.id)}>
              <DropdownMenu.ItemTitle>{p.label}</DropdownMenu.ItemTitle>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>

      {accounts.length === 0 ? (
        <View className="items-center py-10 gap-3">
          <View className="bg-muted/50 p-3 rounded-full">
            <WifiOff size={24} className="text-muted-foreground" />
          </View>
          <Text className="text-sm text-muted-foreground text-center">
            No accounts connected yet. Connect your first account to get started.
          </Text>
        </View>
      ) : (
        <SettingsListGroup>
          {accounts.map((account) => (
            <AccountRow
              key={account._id}
              account={account}
              onDisconnect={handleDisconnect}
            />
          ))}
        </SettingsListGroup>
      )}
    </View>
  );
}
