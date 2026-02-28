import React from 'react';
import { View, Pressable, Share, ActivityIndicator } from 'react-native';
import { Copy, Send, Link2, Users } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useCreateOrgInvite } from '@/lib/hooks/use-organization-invites';

interface OrgInviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  orgName: string;
}

export function OrgInviteDialog({ open, onOpenChange, orgId, orgName }: OrgInviteDialogProps) {
  const [role, setRole] = React.useState<'member' | 'admin'>('member');
  const [inviteUrl, setInviteUrl] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  const createInvite = useCreateOrgInvite();

  const handleGenerate = React.useCallback(async () => {
    const invite = await createInvite.mutateAsync({ orgId, role });
    setInviteUrl(invite.inviteUrl);
  }, [orgId, role, createInvite]);

  const handleCopy = React.useCallback(async () => {
    if (!inviteUrl) return;
    await Clipboard.setStringAsync(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [inviteUrl]);

  const handleShare = React.useCallback(async () => {
    if (!inviteUrl) return;
    try {
      await Share.share({
        message: `Join ${orgName} on Alia!\n${inviteUrl}`,
      });
    } catch {
      // user cancelled
    }
  }, [inviteUrl, orgName]);

  // Reset state when dialog closes
  React.useEffect(() => {
    if (!open) {
      setInviteUrl('');
      setRole('member');
      setCopied(false);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="p-0 sm:p-6"
        className="flex-1 max-w-full rounded-none sm:flex-initial sm:max-w-md sm:rounded-2xl"
      >
        {/* Header Icon */}
        <View className="items-center mb-4">
          <View className="h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Users size={32} className="text-primary" />
          </View>
        </View>

        <DialogHeader className="items-center">
          <DialogTitle className="text-xl text-center">
            Invite to {orgName}
          </DialogTitle>
          <DialogDescription className="text-center">
            Create a shareable invite link. Anyone with the link can join.
          </DialogDescription>
        </DialogHeader>

        {!inviteUrl ? (
          <View className="gap-4">
            {/* Role selector */}
            <View className="gap-2">
              <Text className="text-sm font-medium text-foreground">Role</Text>
              <View className="flex-row gap-2">
                <Pressable
                  onPress={() => setRole('member')}
                  className={`flex-1 items-center py-2.5 rounded-full border ${
                    role === 'member'
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-background'
                  }`}
                >
                  <Text className={`text-sm font-medium ${
                    role === 'member' ? 'text-primary' : 'text-muted-foreground'
                  }`}>
                    Member
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setRole('admin')}
                  className={`flex-1 items-center py-2.5 rounded-full border ${
                    role === 'admin'
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-background'
                  }`}
                >
                  <Text className={`text-sm font-medium ${
                    role === 'admin' ? 'text-primary' : 'text-muted-foreground'
                  }`}>
                    Admin
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* Generate button */}
            <Button
              onPress={handleGenerate}
              disabled={createInvite.isPending}
              className="h-11 rounded-full"
            >
              <View className="flex-row items-center gap-1.5">
                {createInvite.isPending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Link2 size={16} className="text-primary-foreground" />
                )}
                <Text className="text-sm font-medium text-primary-foreground">
                  {createInvite.isPending ? 'Generating...' : 'Generate invite link'}
                </Text>
              </View>
            </Button>
          </View>
        ) : (
          <View className="gap-4">
            {/* Invite link display */}
            <View className="gap-2">
              <Text className="text-sm font-medium text-foreground">
                Share invitation link
              </Text>
              <View className="flex-row items-center gap-2 rounded-full border border-input bg-muted/30 pl-4 pr-1.5 h-11">
                <Text
                  className="flex-1 text-sm text-muted-foreground"
                  numberOfLines={1}
                >
                  {inviteUrl}
                </Text>
                <Pressable
                  onPress={handleCopy}
                  className="flex-row items-center gap-1.5 py-1.5 px-2.5 rounded-full bg-background border border-border active:bg-muted"
                >
                  <Copy size={14} className="text-foreground" />
                  <Text className="text-sm font-medium text-foreground">
                    {copied ? 'Copied!' : 'Copy'}
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* Share button */}
            <Button onPress={handleShare} className="h-11 rounded-full">
              <View className="flex-row items-center gap-1.5">
                <Send size={14} className="text-primary-foreground" />
                <Text className="text-sm font-medium text-primary-foreground">
                  Share invite link
                </Text>
              </View>
            </Button>

            {/* Expiry note */}
            <Text className="text-xs text-muted-foreground text-center">
              This link expires in 7 days
            </Text>
          </View>
        )}
      </DialogContent>
    </Dialog>
  );
}
