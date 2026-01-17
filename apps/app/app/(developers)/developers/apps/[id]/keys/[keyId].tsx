import { View, ScrollView, Pressable, Switch } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useState } from "react";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ArrowLeft, Trash2 } from "lucide-react-native";
import { useApiKeys, useKeyUsage, useUpdateApiKey, useDeleteApiKey } from "@/lib/hooks/use-developer";
import { toast } from "@/components/sonner";

const AVAILABLE_SCOPES = [
  { value: "chat:read", label: "Chat: Read", description: "Read chat messages and conversations" },
  { value: "chat:write", label: "Chat: Write", description: "Send chat messages" },
  { value: "models:read", label: "Models: Read", description: "List available AI models" },
  { value: "conversations:read", label: "Conversations: Read", description: "Read conversation history" },
  { value: "conversations:write", label: "Conversations: Write", description: "Create and update conversations" },
  { value: "conversations:delete", label: "Conversations: Delete", description: "Delete conversations" },
  { value: "memory:read", label: "Memory: Read", description: "Read conversation memory" },
  { value: "memory:write", label: "Memory: Write", description: "Write to conversation memory" },
];

export default function ApiKeyDetailScreen() {
  const router = useRouter();
  const { id, keyId } = useLocalSearchParams<{ id: string; keyId: string }>();
  const { data: apiKeys = [] } = useApiKeys(id!);
  const currentKey = apiKeys.find((k) => k._id === keyId);
  const [period, setPeriod] = useState<string>("7d");
  const { data: usageStats, isLoading: isLoadingUsage } = useKeyUsage(id!, keyId!, period);
  const updateApiKeyMutation = useUpdateApiKey();
  const deleteApiKeyMutation = useDeleteApiKey();

  const [scopes, setScopes] = useState<string[]>(currentKey?.scopes || []);
  const [isActive, setIsActive] = useState(currentKey?.isActive ?? true);
  const [deleteDialog, setDeleteDialog] = useState(false);

  const handleSave = async () => {
    try {
      await updateApiKeyMutation.mutateAsync({
        appId: id!,
        keyId: keyId!,
        data: { scopes, isActive },
      });
      toast.success("API key updated");
      router.back();
    } catch (error: any) {
      toast.error(error.message || "Failed to update API key");
    }
  };

  const handleDelete = async () => {
    try {
      await deleteApiKeyMutation.mutateAsync({ appId: id!, keyId: keyId! });
      setDeleteDialog(false);
      router.back();
      toast.success("API key deleted");
    } catch (error: any) {
      toast.error(error.message || "Failed to delete API key");
    }
  };

  const toggleScope = (scope: string) => {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  };

  if (!currentKey) {
    return (
      <View className="flex-1 bg-background px-6 py-6">
        <Text className="text-sm text-muted-foreground">API key not found</Text>
      </View>
    );
  }

  const summary = usageStats?.summary;
  const byDay = usageStats?.byDay || [];

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-6 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={16} className="text-muted-foreground mr-2" />
          <Text className="text-sm text-muted-foreground">Back</Text>
        </Pressable>
        <Text className="text-2xl font-semibold text-foreground">{currentKey.name}</Text>
        <Text className="text-sm text-muted-foreground mt-1 font-mono">
          {currentKey.keyPrefix}...
        </Text>
      </View>

      {/* Key Details */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Details</Text>

        <View className="mb-4">
          <Text className="text-sm text-muted-foreground mb-1">Created</Text>
          <Text className="text-sm text-foreground">
            {new Date(currentKey.createdAt).toLocaleString()}
          </Text>
        </View>

        {currentKey.lastUsedAt && (
          <View className="mb-4">
            <Text className="text-sm text-muted-foreground mb-1">Last used</Text>
            <Text className="text-sm text-foreground">
              {new Date(currentKey.lastUsedAt).toLocaleString()}
            </Text>
          </View>
        )}

        {currentKey.expiresAt && (
          <View>
            <Text className="text-sm text-muted-foreground mb-1">Expires</Text>
            <Text className="text-sm text-foreground">
              {new Date(currentKey.expiresAt).toLocaleString()}
            </Text>
          </View>
        )}
      </View>

      {/* Status */}
      <View className="px-6 py-6 border-b border-border">
        <View className="flex-row items-center justify-between">
          <View className="flex-1 mr-4">
            <Text className="text-sm font-semibold text-foreground mb-1">Active status</Text>
            <Text className="text-sm text-muted-foreground">
              Inactive keys cannot make API requests
            </Text>
          </View>
          <Switch
            value={isActive}
            onValueChange={setIsActive}
            trackColor={{ false: "#cbd5e1", true: "#3b82f6" }}
            thumbColor="#ffffff"
          />
        </View>
      </View>

      {/* Scopes */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Permissions</Text>
        <Text className="text-sm text-muted-foreground mb-4">
          Select which API endpoints this key can access
        </Text>

        <View>
          {AVAILABLE_SCOPES.map((scope, index) => (
            <Pressable
              key={scope.value}
              onPress={() => toggleScope(scope.value)}
              className={`py-3 ${index < AVAILABLE_SCOPES.length - 1 ? 'border-b border-border' : ''}`}
            >
              <View className="flex-row items-start justify-between">
                <View className="flex-1 mr-3">
                  <Text className="text-sm font-medium text-foreground mb-0.5">
                    {scope.label}
                  </Text>
                  <Text className="text-sm text-muted-foreground">{scope.description}</Text>
                </View>
                <View
                  className={`w-5 h-5 rounded border-2 items-center justify-center ${
                    scopes.includes(scope.value)
                      ? "bg-primary border-primary"
                      : "bg-background border-border"
                  }`}
                >
                  {scopes.includes(scope.value) && (
                    <Text className="text-primary-foreground text-xs">✓</Text>
                  )}
                </View>
              </View>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Usage Statistics */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Usage statistics</Text>

        {/* Period Selector */}
        <View className="flex-row gap-2 mb-6">
          {[
            { value: "24h", label: "24h" },
            { value: "7d", label: "7d" },
            { value: "30d", label: "30d" },
            { value: "90d", label: "90d" },
          ].map((option) => (
            <Pressable
              key={option.value}
              onPress={() => setPeriod(option.value)}
              className={`px-3 py-1.5 rounded-md border ${
                period === option.value
                  ? "border-primary bg-primary/10"
                  : "border-border bg-background"
              }`}
            >
              <Text
                className={`text-sm font-medium ${
                  period === option.value ? "text-primary" : "text-foreground"
                }`}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {isLoadingUsage ? (
          <Text className="text-sm text-muted-foreground">Loading statistics...</Text>
        ) : summary ? (
          <>
            {/* Summary Stats */}
            <View className="flex-row gap-8 mb-6">
              <View>
                <Text className="text-2xl font-semibold text-foreground">
                  {summary.totalRequests.toLocaleString()}
                </Text>
                <Text className="text-sm text-muted-foreground mt-0.5">Requests</Text>
              </View>
              <View>
                <Text className="text-2xl font-semibold text-foreground">
                  {summary.totalTokens.toLocaleString()}
                </Text>
                <Text className="text-sm text-muted-foreground mt-0.5">Tokens</Text>
              </View>
            </View>

            {/* Daily Usage */}
            {byDay.length > 0 && (
              <View>
                <Text className="text-sm font-medium text-foreground mb-3">Daily breakdown</Text>
                {byDay.map((day, index) => (
                  <View
                    key={day._id}
                    className={`py-2 ${index < byDay.length - 1 ? 'border-b border-border' : ''}`}
                  >
                    <View className="flex-row items-center justify-between mb-0.5">
                      <Text className="text-sm text-foreground">{day._id}</Text>
                      <Text className="text-sm text-muted-foreground">
                        {day.requests.toLocaleString()} requests
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </>
        ) : (
          <Text className="text-sm text-muted-foreground">No usage data available</Text>
        )}
      </View>

      {/* Save Changes */}
      <View className="px-6 py-6 border-b border-border">
        <Button
          onPress={handleSave}
          disabled={updateApiKeyMutation.isPending || scopes.length === 0}
          size="sm"
          className="self-start"
        >
          <Text className="text-primary-foreground font-medium text-sm">
            {updateApiKeyMutation.isPending ? "Saving..." : "Save changes"}
          </Text>
        </Button>
        {scopes.length === 0 && (
          <Text className="text-sm text-destructive mt-2">
            At least one permission is required
          </Text>
        )}
      </View>

      {/* Danger Zone */}
      <View className="px-6 py-6">
        <Text className="text-sm font-semibold text-destructive mb-4">Danger zone</Text>
        <Button
          variant="destructive"
          onPress={() => setDeleteDialog(true)}
          size="sm"
          className="self-start"
        >
          <Trash2 size={14} className="text-destructive-foreground mr-1.5" />
          <Text className="text-destructive-foreground font-medium text-sm">Delete API key</Text>
        </Button>
      </View>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialog} onOpenChange={setDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete API key</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{currentKey.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onPress={() => setDeleteDialog(false)} size="sm">
              <Text className="text-foreground font-medium text-sm">Cancel</Text>
            </Button>
            <Button
              variant="destructive"
              onPress={handleDelete}
              disabled={deleteApiKeyMutation.isPending}
              size="sm"
            >
              <Text className="text-destructive-foreground font-medium text-sm">
                {deleteApiKeyMutation.isPending ? "Deleting..." : "Delete"}
              </Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollView>
  );
}
