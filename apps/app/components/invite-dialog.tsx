import React from "react";
import { View, Pressable, ScrollView, Linking } from "react-native";
import { HeartHandshake, Copy, Send } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useReferralInfo, useSendInviteEmail } from "@/lib/hooks/use-referrals";

interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Simple social brand icons as styled text in circles
function SocialButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-1 h-11 items-center justify-center rounded-xl border border-border active:bg-muted"
    >
      <Text className="text-base font-bold text-foreground">{label}</Text>
    </Pressable>
  );
}

export function InviteDialog({ open, onOpenChange }: InviteDialogProps) {
  const { data: referralInfo } = useReferralInfo();
  const sendInvite = useSendInviteEmail();
  const [email, setEmail] = React.useState("");
  const [copied, setCopied] = React.useState(false);

  const inviteUrl = referralInfo?.inviteUrl || "";
  const shareText = `Check out Alia — sign up with my link and we both get 500 credits!`;

  const handleCopy = React.useCallback(async () => {
    if (!inviteUrl) return;
    await Clipboard.setStringAsync(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [inviteUrl]);

  const handleShareFacebook = React.useCallback(() => {
    Linking.openURL(
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(inviteUrl)}`
    );
  }, [inviteUrl]);

  const handleShareX = React.useCallback(() => {
    Linking.openURL(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(inviteUrl)}`
    );
  }, [inviteUrl, shareText]);

  const handleShareLinkedIn = React.useCallback(() => {
    Linking.openURL(
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(inviteUrl)}`
    );
  }, [inviteUrl]);

  const handleShareReddit = React.useCallback(() => {
    Linking.openURL(
      `https://reddit.com/submit?url=${encodeURIComponent(inviteUrl)}&title=${encodeURIComponent(shareText)}`
    );
  }, [inviteUrl, shareText]);

  const handleSendEmail = React.useCallback(async () => {
    if (!email.trim()) return;
    const result = await sendInvite.mutateAsync(email.trim());
    if (result.mailtoUrl) {
      Linking.openURL(result.mailtoUrl);
    }
    setEmail("");
  }, [email, sendInvite]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <ScrollView showsVerticalScrollIndicator={false}>
          {/* Header Icon */}
          <View className="items-center mb-4">
            <View className="h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <HeartHandshake size={32} className="text-primary" />
            </View>
          </View>

          <DialogHeader className="items-center">
            <DialogTitle className="text-xl text-center">
              Invite to get credits
            </DialogTitle>
            <DialogDescription className="text-center">
              Share your invitation link with friends, get 500 credits each.
            </DialogDescription>
          </DialogHeader>

          {/* Share Link */}
          <View className="gap-2 mb-4">
            <Text className="text-sm font-medium text-foreground">
              Share invitation link
            </Text>
            <View className="flex-row items-center gap-2 rounded-xl border border-input bg-muted/30 px-3.5 h-11">
              <Text
                className="flex-1 text-sm text-muted-foreground"
                numberOfLines={1}
              >
                {inviteUrl || "Loading..."}
              </Text>
              <Pressable
                onPress={handleCopy}
                className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg bg-background border border-border active:bg-muted"
              >
                <Copy size={14} className="text-foreground" />
                <Text className="text-sm font-medium text-foreground">
                  {copied ? "Copied!" : "Copy"}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Social Sharing */}
          <View className="flex-row gap-2 mb-4">
            <SocialButton label="f" onPress={handleShareFacebook} />
            <SocialButton label="X" onPress={handleShareX} />
            <SocialButton label="in" onPress={handleShareLinkedIn} />
            <SocialButton label="r/" onPress={handleShareReddit} />
          </View>

          {/* Send Email */}
          <View className="gap-2 mb-4">
            <Text className="text-sm font-medium text-foreground">
              Send invitation email
            </Text>
            <View className="flex-row items-center gap-2">
              <View className="flex-1">
                <Input
                  value={email}
                  onChangeText={setEmail}
                  placeholder="Enter email address"
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
              </View>
              <Button
                onPress={handleSendEmail}
                disabled={!email.trim() || sendInvite.isPending}
                className="h-11 px-4 rounded-xl"
              >
                <View className="flex-row items-center gap-1.5">
                  <Send size={14} className="text-primary-foreground" />
                  <Text className="text-sm font-medium text-primary-foreground">
                    Send
                  </Text>
                </View>
              </Button>
            </View>
          </View>

          {/* Stats Card */}
          <View className="flex-row rounded-xl bg-muted/50 border border-border p-4 mb-4">
            <View className="flex-1">
              <Text className="text-2xl font-bold text-foreground">
                {referralInfo?.totalCreditsEarned ?? 0}
              </Text>
              <Text className="text-xs text-muted-foreground">Credits</Text>
            </View>
            <View className="flex-1">
              <Text className="text-2xl font-bold text-foreground">
                {referralInfo?.totalReferrals ?? 0}
              </Text>
              <Text className="text-xs text-muted-foreground">Referrals</Text>
            </View>
          </View>

          {/* Footer Links */}
          <View className="flex-row items-center justify-center gap-4">
            <Pressable className="active:opacity-70">
              <Text className="text-sm text-muted-foreground">Redeem</Text>
            </Pressable>
            <View className="h-4 w-px bg-border" />
            <Pressable className="active:opacity-70">
              <Text className="text-sm text-muted-foreground">
                Invitation history
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </DialogContent>
    </Dialog>
  );
}
