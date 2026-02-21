import { View, Pressable, ActivityIndicator, TextInput as RNTextInput } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import {
  useMcpServers,
  type InstalledMcpServer,
  type McpRegistryEntry,
} from "@/hooks/useMcpServers";
import { toast } from "@/components/sonner";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Server, Play, Square, Trash2, Download, Wrench } from "lucide-react-native";

function ServerStatusBadge({ status }: { status: InstalledMcpServer["status"] }) {
  const config = {
    running: { label: "Running", bg: "bg-green-500/10", text: "text-green-600" },
    installed: { label: "Installed", bg: "bg-blue-500/10", text: "text-blue-600" },
    stopped: { label: "Stopped", bg: "bg-gray-500/10", text: "text-gray-500" },
    error: { label: "Error", bg: "bg-red-500/10", text: "text-red-600" },
  }[status] ?? { label: status, bg: "bg-gray-500/10", text: "text-gray-500" };

  return (
    <View className={`px-2 py-0.5 rounded-full ${config.bg}`}>
      <Text className={`text-[10px] font-medium ${config.text}`}>{config.label}</Text>
    </View>
  );
}

function InstalledServerRow({
  server,
  onStart,
  onStop,
  onUninstall,
}: {
  server: InstalledMcpServer;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onUninstall: (id: string) => void;
}) {
  return (
    <View className="flex-row items-center py-3 px-1 border-b border-border">
      <View className="bg-primary/10 p-1.5 rounded-lg mr-3">
        <Server size={18} className="text-primary" />
      </View>
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className="text-sm font-medium">{server.displayName || server.name}</Text>
          <ServerStatusBadge status={server.status} />
        </View>
        <View className="flex-row items-center gap-1">
          <Wrench size={10} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">
            {server.tools.length} tool{server.tools.length !== 1 ? "s" : ""}
          </Text>
        </View>
      </View>
      <View className="flex-row items-center gap-1">
        {server.status === "running" ? (
          <Button variant="ghost" size="icon" className="h-8 w-8" onPress={() => onStop(server._id)}>
            <Square size={14} className="text-muted-foreground" />
          </Button>
        ) : (
          <Button variant="ghost" size="icon" className="h-8 w-8" onPress={() => onStart(server._id)}>
            <Play size={14} className="text-primary" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onPress={() => onUninstall(server._id)}
        >
          <Trash2 size={14} className="text-destructive" />
        </Button>
      </View>
    </View>
  );
}

function RegistryCard({
  entry,
  onInstall,
  alreadyInstalled,
}: {
  entry: McpRegistryEntry;
  onInstall: (entry: McpRegistryEntry) => void;
  alreadyInstalled: boolean;
}) {
  return (
    <View className="border border-border rounded-lg p-3 gap-2">
      <View className="flex-row items-start gap-2.5">
        <View className="bg-muted p-1.5 rounded-lg">
          <Server size={16} className="text-muted-foreground" />
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="text-sm font-medium">{entry.name}</Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={2}>
            {entry.description}
          </Text>
          {entry.requiredEnv.length > 0 && (
            <Text className="text-[10px] text-muted-foreground mt-0.5">
              Requires: {entry.requiredEnv.join(", ")}
            </Text>
          )}
        </View>
      </View>
      <Button
        variant="outline"
        size="sm"
        className="h-7 self-end"
        onPress={() => onInstall(entry)}
        disabled={alreadyInstalled}
      >
        <View className="flex-row items-center gap-1">
          <Download size={12} className="text-foreground" />
          <Text className="text-xs">{alreadyInstalled ? "Installed" : "Install"}</Text>
        </View>
      </Button>
    </View>
  );
}

export function McpSection() {
  const { registry, installed, loading, install, uninstall, start, stop, refresh } =
    useMcpServers();
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [installTarget, setInstallTarget] = useState<McpRegistryEntry | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [installing, setInstalling] = useState(false);

  const handleStart = async (serverId: string) => {
    try {
      await start(serverId);
      toast.success("Server started");
    } catch (err) {
      console.error("Failed to start server:", err);
      toast.error("Failed to start server");
    }
  };

  const handleStop = async (serverId: string) => {
    try {
      await stop(serverId);
      toast.success("Server stopped");
    } catch (err) {
      console.error("Failed to stop server:", err);
      toast.error("Failed to stop server");
    }
  };

  const handleUninstall = async () => {
    if (!uninstallTarget) return;
    setUninstalling(true);
    try {
      await uninstall(uninstallTarget);
      toast.success("Server uninstalled");
    } catch (err) {
      console.error("Failed to uninstall server:", err);
      toast.error("Failed to uninstall server");
    } finally {
      setUninstalling(false);
      setUninstallTarget(null);
    }
  };

  const handleInstall = async () => {
    if (!installTarget) return;
    setInstalling(true);
    try {
      const env = installTarget.requiredEnv.length > 0 ? envValues : undefined;
      await install(installTarget.id, env);
      toast.success(`${installTarget.name} installed`);
      setInstallTarget(null);
      setEnvValues({});
    } catch (err) {
      console.error("Failed to install server:", err);
      toast.error("Failed to install server");
    } finally {
      setInstalling(false);
    }
  };

  const openInstallDialog = (entry: McpRegistryEntry) => {
    if (entry.requiredEnv.length === 0) {
      setInstallTarget(null);
      setInstalling(true);
      install(entry.id)
        .then(() => toast.success(`${entry.name} installed`))
        .catch(() => toast.error("Failed to install server"))
        .finally(() => setInstalling(false));
      return;
    }
    setEnvValues({});
    setInstallTarget(entry);
  };

  const installedRegistryIds = new Set(installed.map((s) => s.registryId).filter(Boolean));

  const inputClass =
    "border border-border rounded-lg px-3 py-2 bg-background text-foreground text-sm";

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
          Installed
        </Text>
        {installed.length === 0 ? (
          <View className="items-center py-6">
            <Text className="text-sm text-muted-foreground">No MCP servers installed yet.</Text>
          </View>
        ) : (
          <View>
            {installed.map((server) => (
              <InstalledServerRow
                key={server._id}
                server={server}
                onStart={handleStart}
                onStop={handleStop}
                onUninstall={(id) => setUninstallTarget(id)}
              />
            ))}
          </View>
        )}
      </View>

      {registry.length > 0 && (
        <View className="gap-3">
          <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
            Browse Registry
          </Text>
          <View className="gap-2">
            {registry.map((entry) => (
              <RegistryCard
                key={entry.id}
                entry={entry}
                onInstall={openInstallDialog}
                alreadyInstalled={installedRegistryIds.has(entry.id)}
              />
            ))}
          </View>
        </View>
      )}

      <ConfirmationDialog
        open={!!uninstallTarget}
        onOpenChange={(open) => !open && setUninstallTarget(null)}
        title="Uninstall Server"
        description="Are you sure you want to uninstall this MCP server? This will remove all its configuration."
        confirmText="Uninstall"
        cancelText="Cancel"
        confirmVariant="destructive"
        onConfirm={handleUninstall}
        loading={uninstalling}
      />

      <Dialog open={!!installTarget} onOpenChange={(open) => !open && setInstallTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader className="gap-1">
            <DialogTitle className="text-lg">Install {installTarget?.name}</DialogTitle>
            <DialogDescription className="text-sm">
              This server requires the following environment variables.
            </DialogDescription>
          </DialogHeader>
          <View className="gap-3">
            {installTarget?.requiredEnv.map((envKey) => (
              <View key={envKey} className="gap-1">
                <Text className="text-xs font-medium text-muted-foreground">{envKey}</Text>
                <RNTextInput
                  className={inputClass}
                  placeholder={`Enter ${envKey}`}
                  placeholderTextColor="#9ca3af"
                  value={envValues[envKey] || ""}
                  onChangeText={(val) => setEnvValues((prev) => ({ ...prev, [envKey]: val }))}
                  secureTextEntry={envKey.toLowerCase().includes("secret") || envKey.toLowerCase().includes("key")}
                />
              </View>
            ))}
          </View>
          <DialogFooter className="gap-2 mt-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-9"
              onPress={() => setInstallTarget(null)}
              disabled={installing}
            >
              <Text className="text-sm">Cancel</Text>
            </Button>
            <Button
              size="sm"
              className="flex-1 h-9"
              onPress={handleInstall}
              disabled={installing}
            >
              <Text className="text-sm">{installing ? "Installing..." : "Install"}</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}
