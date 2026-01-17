import { View, ScrollView, Pressable, TextInput as RNTextInput } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useState } from "react";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ArrowLeft, Plus, Copy, Trash2, ChevronRight } from "lucide-react-native";
import { useApp, useApiKeys, useCreateApiKey, useDeleteApiKey, useDeleteApp } from "@/lib/hooks/use-developer";
import * as Clipboard from 'expo-clipboard';
import { toast } from "@/components/sonner";

export default function AppDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: currentApp, isLoading: isLoadingApp } = useApp(id!);
  const { data: apiKeys = [], isLoading: isLoadingKeys } = useApiKeys(id!);
  const createApiKeyMutation = useCreateApiKey();
  const deleteApiKeyMutation = useDeleteApiKey();
  const deleteAppMutation = useDeleteApp();

  const [showNewKeyModal, setShowNewKeyModal] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [deleteAppDialog, setDeleteAppDialog] = useState(false);
  const [deleteKeyDialog, setDeleteKeyDialog] = useState<{ id: string; name: string } | null>(null);

  const handleDeleteApp = async () => {
    try {
      await deleteAppMutation.mutateAsync(id!);
      setDeleteAppDialog(false);
      router.replace("/developers");
      toast.success("App deleted successfully");
    } catch (error: any) {
      toast.error(error.message || "Failed to delete app");
    }
  };

  const handleCreateKey = async () => {
    if (!keyName.trim()) {
      toast.error("Please enter a key name");
      return;
    }

    try {
      const result = await createApiKeyMutation.mutateAsync({
        appId: id!,
        data: {
          name: keyName.trim(),
          scopes: ["chat:read", "chat:write", "models:read"],
        },
      });

      setNewlyCreatedKey(result.apiKey.key || null);
      setShowNewKeyModal(false);
      setKeyName("");
      toast.success("API key created successfully");
    } catch (error: any) {
      toast.error(error.message || "Failed to create API key");
    }
  };

  const handleDeleteKey = async () => {
    if (!deleteKeyDialog) return;

    try {
      await deleteApiKeyMutation.mutateAsync({ appId: id!, keyId: deleteKeyDialog.id });
      setDeleteKeyDialog(null);
      toast.success("API key deleted");
    } catch (error: any) {
      toast.error(error.message || "Failed to delete API key");
    }
  };

  const handleCopyKey = async (key: string) => {
    await Clipboard.setStringAsync(key);
    toast.success("API key copied to clipboard");
  };

  if (isLoadingApp || !currentApp) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-sm text-muted-foreground">Loading...</Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-6 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={16} className="text-muted-foreground mr-2" />
          <Text className="text-sm text-muted-foreground">Back</Text>
        </Pressable>
        <Text className="text-2xl font-semibold text-foreground">{currentApp.name}</Text>
        {currentApp.description && (
          <Text className="text-sm text-muted-foreground mt-1">{currentApp.description}</Text>
        )}
      </View>

      {/* App Details */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Details</Text>

        <View className="mb-4">
          <Text className="text-sm text-muted-foreground mb-1">App ID</Text>
          <Text className="text-sm text-foreground font-mono">{currentApp._id}</Text>
        </View>

        {currentApp.websiteUrl && (
          <View className="mb-4">
            <Text className="text-sm text-muted-foreground mb-1">Website</Text>
            <Text className="text-sm text-foreground">{currentApp.websiteUrl}</Text>
          </View>
        )}

        <View className="mb-4">
          <Text className="text-sm text-muted-foreground mb-1">Status</Text>
          <View className="flex-row items-center">
            {currentApp.isActive ? (
              <View className="px-2 py-0.5 rounded bg-green-100">
                <Text className="text-xs font-medium text-green-700">Active</Text>
              </View>
            ) : (
              <View className="px-2 py-0.5 rounded bg-gray-100">
                <Text className="text-xs font-medium text-gray-700">Inactive</Text>
              </View>
            )}
          </View>
        </View>

        <View>
          <Text className="text-sm text-muted-foreground mb-1">Created</Text>
          <Text className="text-sm text-foreground">
            {new Date(currentApp.createdAt).toLocaleDateString()}
          </Text>
        </View>
      </View>

      {/* API Keys */}
      <View className="px-6 py-6 border-b border-border">
        <View className="flex-row items-center justify-between mb-4">
          <Text className="text-sm font-semibold text-foreground">API keys</Text>
          <Button onPress={() => setShowNewKeyModal(true)} size="sm">
            <Plus size={14} className="text-primary-foreground mr-1.5" />
            <Text className="text-primary-foreground font-medium text-sm">Create key</Text>
          </Button>
        </View>

        {/* New Key Alert */}
        {newlyCreatedKey && (
          <View className="mb-4 p-4 rounded-md bg-yellow-50 border border-yellow-200">
            <Text className="text-sm font-semibold text-yellow-900 mb-2">
              Save your API key
            </Text>
            <Text className="text-xs text-yellow-800 mb-3">
              Make sure to copy your API key now. You won't be able to see it again!
            </Text>
            <Pressable
              onPress={() => handleCopyKey(newlyCreatedKey)}
              className="flex-row items-center p-2 rounded bg-yellow-100"
            >
              <Text className="flex-1 text-sm font-mono text-yellow-900" numberOfLines={1}>
                {newlyCreatedKey}
              </Text>
              <Copy size={16} className="text-yellow-700 ml-2" />
            </Pressable>
            <Button
              variant="outline"
              onPress={() => setNewlyCreatedKey(null)}
              size="sm"
              className="mt-3 self-start"
            >
              <Text className="text-foreground font-medium text-sm">I saved my key</Text>
            </Button>
          </View>
        )}

        {isLoadingKeys ? (
          <Text className="text-sm text-muted-foreground py-4">Loading keys...</Text>
        ) : apiKeys.length === 0 ? (
          <Text className="text-sm text-muted-foreground py-4">
            No API keys yet. Create one to get started.
          </Text>
        ) : (
          <View>
            {apiKeys.map((key, index) => (
              <View
                key={key._id}
                className={`py-3 ${index < apiKeys.length - 1 ? 'border-b border-border' : ''}`}
              >
                <View className="flex-row items-center justify-between mb-1">
                  <Text className="text-sm font-medium text-foreground">{key.name}</Text>
                  <Pressable
                    onPress={() => setDeleteKeyDialog({ id: key._id, name: key.name })}
                    className="p-1"
                  >
                    <Trash2 size={16} className="text-destructive" />
                  </Pressable>
                </View>
                <Text className="text-sm text-muted-foreground font-mono">{key.keyPrefix}...</Text>
                <Text className="text-xs text-muted-foreground mt-1">
                  Created {new Date(key.createdAt).toLocaleDateString()}
                  {key.lastUsedAt && ` • Last used ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* Usage Stats Link */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Analytics</Text>
        <Pressable
          onPress={() => router.push(`/developers/apps/${id}/usage`)}
          className="flex-row items-center justify-between py-3 active:opacity-70"
        >
          <Text className="text-sm text-foreground">View usage statistics</Text>
          <ChevronRight size={16} className="text-muted-foreground" />
        </Pressable>
      </View>

      {/* Danger Zone */}
      <View className="px-6 py-6">
        <Text className="text-sm font-semibold text-destructive mb-4">Danger zone</Text>
        <Button
          variant="destructive"
          onPress={() => setDeleteAppDialog(true)}
          size="sm"
          className="self-start"
        >
          <Trash2 size={14} className="text-destructive-foreground mr-1.5" />
          <Text className="text-destructive-foreground font-medium text-sm">Delete app</Text>
        </Button>
      </View>

      {/* Create API Key Modal */}
      <Dialog open={showNewKeyModal} onOpenChange={setShowNewKeyModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Give your API key a name to help you identify it later.
            </DialogDescription>
          </DialogHeader>
          <View className="py-4">
            <Text className="text-sm font-semibold text-foreground mb-2">Key name</Text>
            <RNTextInput
              value={keyName}
              onChangeText={setKeyName}
              placeholder="Production Key"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
              placeholderTextColor="#9CA3AF"
              maxLength={100}
            />
          </View>
          <DialogFooter>
            <Button variant="outline" onPress={() => setShowNewKeyModal(false)} size="sm">
              <Text className="text-foreground font-medium text-sm">Cancel</Text>
            </Button>
            <Button
              onPress={handleCreateKey}
              disabled={createApiKeyMutation.isPending || !keyName.trim()}
              size="sm"
            >
              <Text className="text-primary-foreground font-medium text-sm">
                {createApiKeyMutation.isPending ? "Creating..." : "Create"}
              </Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete App Confirmation Dialog */}
      <Dialog open={deleteAppDialog} onOpenChange={setDeleteAppDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete app</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this app? This will also delete all API keys and usage data. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onPress={() => setDeleteAppDialog(false)} size="sm">
              <Text className="text-foreground font-medium text-sm">Cancel</Text>
            </Button>
            <Button
              variant="destructive"
              onPress={handleDeleteApp}
              disabled={deleteAppMutation.isPending}
              size="sm"
            >
              <Text className="text-destructive-foreground font-medium text-sm">
                {deleteAppMutation.isPending ? "Deleting..." : "Delete"}
              </Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete API Key Confirmation Dialog */}
      <Dialog open={!!deleteKeyDialog} onOpenChange={(open) => !open && setDeleteKeyDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete API key</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteKeyDialog?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onPress={() => setDeleteKeyDialog(null)} size="sm">
              <Text className="text-foreground font-medium text-sm">Cancel</Text>
            </Button>
            <Button
              variant="destructive"
              onPress={handleDeleteKey}
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
