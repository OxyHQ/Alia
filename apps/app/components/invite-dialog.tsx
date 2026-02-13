import React from "react";
import { View, Pressable, ScrollView, Linking, Share } from "react-native";
import { HeartHandshake, Copy, Send } from "lucide-react-native";
import Fontisto from "@expo/vector-icons/Fontisto";
import * as Clipboard from "expo-clipboard";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useReferralInfo } from "@/lib/hooks/use-referrals";

const SHARE_TEXT = "Check out Alia — sign up with my link and we both get 500 credits!";

interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SocialButton = React.memo(function SocialButton({
  iconName,
  onPress,
}: {
  iconName: React.ComponentProps<typeof Fontisto>["name"];
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="h-11 w-11 items-center justify-center rounded-full border border-border active:bg-muted"
    >
      <Fontisto name={iconName} size={18} className="text-foreground" />
    </Pressable>
  );
});

export function InviteDialog({ open, onOpenChange }: InviteDialogProps) {
  const { data: referralInfo } = useReferralInfo();
  const [copied, setCopied] = React.useState(false);

  const inviteUrl = referralInfo?.inviteUrl || "";

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
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(inviteUrl)}`
    );
  }, [inviteUrl]);

  const handleShareLinkedIn = React.useCallback(() => {
    Linking.openURL(
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(inviteUrl)}`
    );
  }, [inviteUrl]);

  const handleShareReddit = React.useCallback(() => {
    Linking.openURL(
      `https://reddit.com/submit?url=${encodeURIComponent(inviteUrl)}&title=${encodeURIComponent(SHARE_TEXT)}`
    );
  }, [inviteUrl]);

  const handleShareWhatsApp = React.useCallback(() => {
    Linking.openURL(
      `https://wa.me/?text=${encodeURIComponent(`${SHARE_TEXT}\n${inviteUrl}`)}`
    );
  }, [inviteUrl]);

  const handleShareTelegram = React.useCallback(() => {
    Linking.openURL(
      `https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${encodeURIComponent(SHARE_TEXT)}`
    );
  }, [inviteUrl]);

  const handleSharePinterest = React.useCallback(() => {
    Linking.openURL(
      `https://pinterest.com/pin/create/button/?url=${encodeURIComponent(inviteUrl)}&description=${encodeURIComponent(SHARE_TEXT)}`
    );
  }, [inviteUrl]);

  const handleShare = React.useCallback(async () => {
    if (!inviteUrl) return;
    await Share.share({
      message: `${SHARE_TEXT}\n${inviteUrl}`,
    });
  }, [inviteUrl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="p-0 sm:p-6"
        className="flex-1 max-w-full rounded-none sm:flex-initial sm:max-w-md sm:rounded-2xl"
      >
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
            <View className="flex-row items-center gap-2 rounded-full border border-input bg-muted/30 pl-4 pr-1.5 h-11">
              <Text
                className="flex-1 text-sm text-muted-foreground"
                numberOfLines={1}
              >
                {inviteUrl || "Loading..."}
              </Text>
              <Pressable
                onPress={handleCopy}
                className="flex-row items-center gap-1.5 py-1.5 px-2.5 rounded-full bg-background border border-border active:bg-muted"
              >
                <Copy size={14} className="text-foreground" />
                <Text className="text-sm font-medium text-foreground">
                  {copied ? "Copied!" : "Copy"}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Social Sharing */}
          <View className="flex-row flex-wrap justify-center gap-3 mb-4">
            <SocialButton iconName="facebook" onPress={handleShareFacebook} />
            <SocialButton iconName="twitter" onPress={handleShareX} />
            <SocialButton iconName="linkedin" onPress={handleShareLinkedIn} />
            <SocialButton iconName="reddit" onPress={handleShareReddit} />
            <SocialButton iconName="whatsapp" onPress={handleShareWhatsApp} />
            <SocialButton iconName="telegram" onPress={handleShareTelegram} />
            <SocialButton iconName="pinterest" onPress={handleSharePinterest} />
          </View>

          {/* Share */}
          <Button onPress={handleShare} className="h-11 rounded-full mb-4">
            <View className="flex-row items-center gap-1.5">
              <Send size={14} className="text-primary-foreground" />
              <Text className="text-sm font-medium text-primary-foreground">
                Share invite link
              </Text>
            </View>
          </Button>

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
