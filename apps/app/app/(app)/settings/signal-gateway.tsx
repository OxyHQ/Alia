import { View, Pressable, ActivityIndicator, ScrollView } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { useRouter } from "expo-router";
import { useGatewaySessions, type GatewaySession } from "@/hooks/useGatewaySessions";
import { Shield, CheckCircle, Plus, Trash2 } from "lucide-react-native";
import { SettingsHeader } from "@/components/settings/settings-header";
import { toast } from "@/components/sonner";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import QRCode from "react-native-qrcode-svg";
import { useTranslation } from "@/hooks/useTranslation";

export default function SignalGatewayScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { sessions, loading, connectNew, disconnect, stopPolling } = useGatewaySessions('signal-gateway');
  const [connecting, setConnecting] = useState(false);
  const [qrData, setQrData] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<GatewaySession | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const connectedSessions = sessions.filter(s => s.status === 'connected');
  const pendingSession = sessions.find(s => s.sessionId === activeSessionId);
  const isLinking = pendingSession?.status === 'linking';

  useEffect(() => {
    return () => stopPolling();
  }, []);

  useEffect(() => {
    if (pendingSession?.lastQR) {
      setQrData(pendingSession.lastQR);
    }
    if (pendingSession?.status === 'connected') {
      setConnecting(false);
      setQrData(null);
      setActiveSessionId(null);
      toast.success(t('gateways.signal.connected'));
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
      toast.error(t('gateways.signal.failedToConnect'));
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!disconnectTarget) return;
    try {
      setDisconnecting(true);
      await disconnect(disconnectTarget.sessionId);
      toast.success(t('gateways.signal.disconnected'));
    } catch (err) {
      toast.error(t('gateways.signal.failedToDisconnect'));
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
      <SettingsHeader
        title={t('gateways.signal.title')}
        subtitle={t('gateways.signal.subtitle')}
        showBack
      />

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
                    {t('gateways.connectedAccounts', { count: connectedSessions.length })}
                  </Text>
                  {connectedSessions.map((session) => (
                    <View
                      key={session.sessionId}
                      className="border border-border rounded-xl p-4 bg-surface flex-row items-center gap-3"
                    >
                      <View className="bg-[#3A76F0]/10 p-2 rounded-full">
                        <CheckCircle size={24} color="#3A76F0" />
                      </View>
                      <View className="flex-1">
                        <Text className="text-base font-semibold">
                          {session.displayName || t('gateways.signal.accountFallback')}
                        </Text>
                        {session.phoneNumber && (
                          <Text className="text-sm text-muted-foreground">
                            {session.phoneNumber}
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
              {(qrData || isLinking) ? (
                <View className="items-center gap-4">
                  <Text className="text-lg font-semibold text-center">{t('gateways.scanQRCode')}</Text>
                  <Text className="text-sm text-muted-foreground text-center">
                    {t('gateways.signal.scanInstructions')}
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
                      <Text className="text-sm text-muted-foreground mt-2">{t('gateways.generatingQR')}</Text>
                    </View>
                  )}

                  <View className="flex-row items-center gap-2 mt-2">
                    <ActivityIndicator size="small" />
                    <Text className="text-sm text-muted-foreground">{t('gateways.waitingForScan')}</Text>
                  </View>

                  <Button variant="outline" className="w-full mt-2" onPress={handleCancelQR}>
                    <Text>{t('common.cancel')}</Text>
                  </Button>
                </View>
              ) : (
                /* Add Account Button */
                <View className="items-center gap-4">
                  {connectedSessions.length === 0 && (
                    <>
                      <View className="bg-[#3A76F0]/10 p-6 rounded-full">
                        <Shield size={48} color="#3A76F0" />
                      </View>
                      <Text className="text-xl font-bold text-center">{t('gateways.signal.linkYour')}</Text>
                      <Text className="text-sm text-muted-foreground text-center leading-5">
                        {t('gateways.signal.linkDescription')}
                      </Text>

                      <View className="bg-muted/50 rounded-xl p-4 w-full gap-2 mt-2">
                        <Text className="text-sm font-medium">{t('gateways.howItWorks')}</Text>
                        <Text className="text-sm text-muted-foreground">{t('gateways.step1')}</Text>
                        <Text className="text-sm text-muted-foreground">{t('gateways.step2')}</Text>
                        <Text className="text-sm text-muted-foreground">{t('gateways.signal.step3')}</Text>
                        <Text className="text-sm text-muted-foreground">{t('gateways.signal.step4')}</Text>
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
                          ? t('gateways.signal.linking')
                          : connectedSessions.length > 0
                            ? t('gateways.signal.addAnother')
                            : t('gateways.signal.connect')
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
        title={t('gateways.signal.disconnectTitle')}
        description={t('gateways.signal.disconnectDescription', { name: disconnectTarget?.displayName || t('gateways.signal.accountFallback') })}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        confirmVariant="destructive"
        onConfirm={handleDisconnect}
        loading={disconnecting}
      />
    </View>
  );
}
