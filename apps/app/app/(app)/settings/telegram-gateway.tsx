import { View, Pressable, ActivityIndicator, ScrollView } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { useRouter } from "expo-router";
import { useGatewaySessions, type GatewaySession } from "@/hooks/useGatewaySessions";
import { ChevronLeft, Send, CheckCircle, XCircle, Plus, Trash2 } from "lucide-react-native";
import { toast } from "@/components/sonner";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import QRCode from "react-native-qrcode-svg";

export default function TelegramGatewayScreen() {
  const router = useRouter();
  const { sessions, loading, connectNew, disconnect, stopPolling, refresh } = useGatewaySessions('telegram-gateway');
  const [connecting, setConnecting] = useState(false);
  const [qrData, setQrData] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<GatewaySession | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const connectedSessions = sessions.filter(s => s.status === 'connected');
  const pendingSession = sessions.find(s => s.sessionId === activeSessionId);
  const isQrPending = pendingSession?.status === 'qr-pending';

  // Stop polling on unmount
  useEffect(() => {
    return () => stopPolling();
  }, []);

  // Update QR data from session status
  useEffect(() => {
    if (pendingSession?.lastQR) {
      setQrData(pendingSession.lastQR);
    }
    if (pendingSession?.status === 'connected') {
      setConnecting(false);
      setQrData(null);
      setActiveSessionId(null);
      toast.success("Telegram connected!");
    }
  }, [pendingSession]);

  const handleConnect = async () => {
    try {
      setConnecting(true);
      const data = await connectNew();
      setActiveSessionId(data.sessionId);
      if (data.qr) {
        setQrData(data.qr);
      }
    } catch (err) {
      toast.error("Failed to start Telegram connection");
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!disconnectTarget) return;
    try {
      setDisconnecting(true);
      await disconnect(disconnectTarget.sessionId);
      toast.success("Telegram disconnected");
    } catch (err) {
      toast.error("Failed to disconnect Telegram");
    } finally {
      setDisconnecting(false);
      setDisconnectTarget(null);
    }
  };

  const handleCancelQR = () => {
    setQrData(null);
    setConnecting(false);
    setActiveSessionId(null);
    stopPolling();
  };

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="border-b border-border p-4 flex-row items-center gap-3">
        <Pressable onPress={() => router.back()} className="p-1">
          <ChevronLeft size={24} className="text-foreground" />
        </Pressable>
        <View>
          <Text className="text-xl font-bold">Telegram Gateway</Text>
          <Text className="text-sm text-muted-foreground">
            Link your Telegram accounts for Alia to respond as you
          </Text>
        </View>
      </View>

      <ScrollView className="flex-1 p-6">
        <View className="max-w-sm w-full mx-auto gap-6">
          {loading && !connecting ? (
            <View className="items-center py-12">
              <ActivityIndicator size="large" />
            </View>
          ) : (
            <>
              {/* Connected Accounts */}
              {connectedSessions.length > 0 && (
                <View className="gap-3">
                  <Text className="text-sm font-semibold text-muted-foreground">
                    Connected Accounts ({connectedSessions.length})
                  </Text>
                  {connectedSessions.map((session) => (
                    <View
                      key={session.sessionId}
                      className="border border-border rounded-xl p-4 bg-surface flex-row items-center gap-3"
                    >
                      <View className="bg-[#0088CC]/10 p-2 rounded-full">
                        <CheckCircle size={24} color="#0088CC" />
                      </View>
                      <View className="flex-1">
                        <Text className="text-base font-semibold">
                          {session.displayName || 'Telegram Account'}
                        </Text>
                        {session.phoneNumber && (
                          <Text className="text-sm text-muted-foreground">
                            +{session.phoneNumber}
                          </Text>
                        )}
                      </View>
                      <Pressable
                        onPress={() => setDisconnectTarget(session)}
                        className="p-2"
                      >
                        <Trash2 size={18} className="text-destructive" />
                      </Pressable>
                    </View>
                  ))}
                </View>
              )}

              {/* QR Code Flow */}
              {(qrData || isQrPending) ? (
                <View className="items-center gap-4">
                  <Text className="text-lg font-semibold text-center">Scan QR Code</Text>
                  <Text className="text-sm text-muted-foreground text-center">
                    Open Telegram on your phone, go to Settings &gt; Devices &gt; Link Desktop Device, then scan this code.
                  </Text>

                  {qrData ? (
                    <View className="bg-white p-4 rounded-2xl">
                      <QRCode
                        value={qrData}
                        size={250}
                        backgroundColor="white"
                        color="black"
                      />
                    </View>
                  ) : (
                    <View className="w-[282px] h-[282px] bg-muted rounded-2xl items-center justify-center">
                      <ActivityIndicator size="large" />
                      <Text className="text-sm text-muted-foreground mt-2">Generating QR code...</Text>
                    </View>
                  )}

                  <View className="flex-row items-center gap-2 mt-2">
                    <ActivityIndicator size="small" />
                    <Text className="text-sm text-muted-foreground">Waiting for scan...</Text>
                  </View>

                  <Button variant="outline" className="w-full mt-2" onPress={handleCancelQR}>
                    <Text>Cancel</Text>
                  </Button>
                </View>
              ) : (
                /* Add Account Button */
                <View className="items-center gap-4">
                  {connectedSessions.length === 0 && (
                    <>
                      <View className="bg-[#0088CC]/10 p-6 rounded-full">
                        <Send size={48} color="#0088CC" />
                      </View>
                      <Text className="text-xl font-bold text-center">Link Your Telegram</Text>
                      <Text className="text-sm text-muted-foreground text-center leading-5">
                        Connect your Telegram account to let Alia respond to messages on your behalf. You'll scan a QR code with your phone, just like Telegram Desktop.
                      </Text>

                      <View className="bg-muted/50 rounded-xl p-4 w-full gap-2 mt-2">
                        <Text className="text-sm font-medium">How it works:</Text>
                        <Text className="text-sm text-muted-foreground">1. Tap "Connect" below</Text>
                        <Text className="text-sm text-muted-foreground">2. A QR code will appear</Text>
                        <Text className="text-sm text-muted-foreground">3. Open Telegram &gt; Settings &gt; Devices</Text>
                        <Text className="text-sm text-muted-foreground">4. Tap "Link Desktop Device" and scan</Text>
                      </View>
                    </>
                  )}

                  <Button
                    className="w-full mt-4"
                    onPress={handleConnect}
                    disabled={connecting}
                  >
                    <View className="flex-row items-center gap-2">
                      {connectedSessions.length > 0 && <Plus size={18} className="text-primary-foreground" />}
                      <Text className="text-primary-foreground">
                        {connecting
                          ? "Connecting..."
                          : connectedSessions.length > 0
                            ? "Add Another Telegram"
                            : "Connect Telegram"
                        }
                      </Text>
                    </View>
                  </Button>
                </View>
              )}
            </>
          )}
        </View>
      </ScrollView>

      <ConfirmationDialog
        open={!!disconnectTarget}
        onOpenChange={(open) => !open && setDisconnectTarget(null)}
        title="Disconnect Telegram"
        description={`This will disconnect ${disconnectTarget?.displayName || 'this Telegram account'} from Alia. You'll need to scan the QR code again to reconnect.`}
        confirmText="Disconnect"
        cancelText="Cancel"
        confirmVariant="destructive"
        onConfirm={handleDisconnect}
        loading={disconnecting}
      />
    </View>
  );
}
