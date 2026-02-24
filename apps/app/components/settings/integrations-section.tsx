import { View, ActivityIndicator, Linking } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useState, useEffect, useRef } from "react";
import {
  useIntegrations,
  type ConnectedIntegration,
  type IntegrationEntry,
} from "@/hooks/useIntegrations";
import { toast } from "@/components/sonner";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Link2, Unlink, ExternalLink, Plug } from "lucide-react-native";

function IntegrationStatusBadge({ status }: { status: ConnectedIntegration["status"] }) {
  const config = {
    active: { label: "Active", bg: "bg-green-500/10", text: "text-green-600" },
    expired: { label: "Expired", bg: "bg-yellow-500/10", text: "text-yellow-600" },
    revoked: { label: "Revoked", bg: "bg-gray-500/10", text: "text-gray-500" },
    error: { label: "Error", bg: "bg-red-500/10", text: "text-red-600" },
  }[status] ?? { label: status, bg: "bg-gray-500/10", text: "text-gray-500" };

  return (
    <View className={`px-2 py-0.5 rounded-full ${config.bg}`}>
      <Text className={`text-[10px] font-medium ${config.text}`}>{config.label}</Text>
    </View>
  );
}

function ConnectedRow({
  integration,
  onDisconnect,
}: {
  integration: ConnectedIntegration;
  onDisconnect: (id: string) => void;
}) {
  return (
    <View className="flex-row items-center py-3 px-1 border-b border-border">
      <View className="bg-primary/10 p-1.5 rounded-lg mr-3">
        <Link2 size={18} className="text-primary" />
      </View>
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className="text-sm font-medium">{integration.displayName}</Text>
          <IntegrationStatusBadge status={integration.status} />
        </View>
        <Text className="text-xs text-muted-foreground">
          {integration.accountName || integration.accountId || integration.service}
        </Text>
      </View>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        onPress={() => onDisconnect(integration._id)}
      >
        <Unlink size={14} className="text-destructive" />
      </Button>
    </View>
  );
}

function AvailableCard({
  entry,
  onConnect,
  connecting,
}: {
  entry: IntegrationEntry;
  onConnect: (service: string) => void;
  connecting: boolean;
}) {
  return (
    <View className="border border-border rounded-lg p-3 gap-2">
      <View className="flex-row items-start gap-2.5">
        <View className="bg-muted p-1.5 rounded-lg">
          <Plug size={16} className="text-muted-foreground" />
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="text-sm font-medium">{entry.name}</Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={2}>
            {entry.description}
          </Text>
        </View>
      </View>
      <Button
        variant="outline"
        size="sm"
        className="h-7 self-end"
        onPress={() => onConnect(entry.service)}
        disabled={connecting}
      >
        <View className="flex-row items-center gap-1">
          <ExternalLink size={12} className="text-foreground" />
          <Text className="text-xs">Connect</Text>
        </View>
      </Button>
    </View>
  );
}

export function IntegrationsSection({
  connectedService,
  onConnectedHandled,
}: {
  connectedService?: string;
  onConnectedHandled?: () => void;
}) {
  const { available, connected, loading, getOAuthUrl, disconnect, refresh } = useIntegrations();
  const [connectingService, setConnectingService] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const handledRef = useRef(false);

  useEffect(() => {
    if (connectedService && !loading && !handledRef.current) {
      handledRef.current = true;
      refresh();
      toast.success(`${connectedService} connected successfully`);
      onConnectedHandled?.();
    }
  }, [connectedService, loading]);

  const connectedServices = new Set(connected.map((c) => c.service));
  const availableNotConnected = available.filter((a) => !connectedServices.has(a.service));

  const handleConnect = async (service: string) => {
    setConnectingService(service);
    try {
      const url = await getOAuthUrl(service);
      await Linking.openURL(url);
    } catch (err) {
      console.error("Failed to start OAuth flow:", err);
      toast.error("Failed to start connection");
    } finally {
      setConnectingService(null);
    }
  };

  const handleDisconnect = async () => {
    if (!disconnectTarget) return;
    setDisconnecting(true);
    try {
      await disconnect(disconnectTarget);
      toast.success("Integration disconnected");
    } catch (err) {
      console.error("Failed to disconnect integration:", err);
      toast.error("Failed to disconnect integration");
    } finally {
      setDisconnecting(false);
      setDisconnectTarget(null);
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
    <View className="gap-6">
      <View className="gap-3">
        <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
          Connected
        </Text>
        {connected.length === 0 ? (
          <View className="items-center py-6">
            <Text className="text-sm text-muted-foreground">No integrations connected yet.</Text>
          </View>
        ) : (
          <View>
            {connected.map((integration) => (
              <ConnectedRow
                key={integration._id}
                integration={integration}
                onDisconnect={(id) => setDisconnectTarget(id)}
              />
            ))}
          </View>
        )}
      </View>

      {availableNotConnected.length > 0 && (
        <View className="gap-3">
          <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
            Available
          </Text>
          <View className="gap-2">
            {availableNotConnected.map((entry) => (
              <AvailableCard
                key={entry.service}
                entry={entry}
                onConnect={handleConnect}
                connecting={connectingService === entry.service}
              />
            ))}
          </View>
        </View>
      )}

      <ConfirmationDialog
        open={!!disconnectTarget}
        onOpenChange={(open) => !open && setDisconnectTarget(null)}
        title="Disconnect Integration"
        description="Are you sure you want to disconnect this integration? You can reconnect it anytime."
        confirmText="Disconnect"
        cancelText="Cancel"
        confirmVariant="destructive"
        onConfirm={handleDisconnect}
        loading={disconnecting}
      />
    </View>
  );
}
