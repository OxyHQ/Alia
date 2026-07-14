import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { Users, ArrowRight, LogIn, AlertCircle } from 'lucide-react-native';
import { useAuth } from '@oxyhq/services';
import { AuthContainer } from '@/components/auth/auth-container';
import { AuthLogo } from '@/components/auth/auth-logo';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useOrgInviteInfo, useAcceptOrgInvite } from '@/lib/hooks/use-organization-invites';

export default function OrgInviteScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading, signIn } = useAuth();
  const { data: inviteData, isLoading: infoLoading, error: infoError } = useOrgInviteInfo(token || '');
  const acceptMutation = useAcceptOrgInvite();
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orgName = inviteData?.invite?.organization?.name || 'this organization';
  const role = inviteData?.invite?.role || 'member';

  const handleAccept = React.useCallback(() => {
    if (!token) return;
    acceptMutation.mutate(token, {
      onSuccess: () => setAccepted(true),
      onError: (err: any) => {
        setError(err?.response?.data?.error || 'Failed to accept invitation');
      },
    });
  }, [token, acceptMutation]);

  if (authLoading || infoLoading) {
    return (
      <AuthContainer>
        <AuthLogo />
        <View className="items-center justify-center py-8">
          <Text className="text-muted-foreground">Loading...</Text>
        </View>
      </AuthContainer>
    );
  }

  // Invite not found / expired
  if (infoError || (!infoLoading && !inviteData)) {
    return (
      <>
        <Head>
          <title>Invalid Invite - Alia</title>
        </Head>
        <AuthContainer>
          <View className="items-center gap-6">
            <View className="h-20 w-20 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircle size={40} className="text-destructive" />
            </View>
            <Text className="text-2xl font-bold text-foreground text-center">
              Invite not found
            </Text>
            <Text className="text-base text-muted-foreground text-center">
              This invitation link is invalid, expired, or has already been used.
            </Text>
            <Button
              onPress={() => router.replace('/(app)')}
              className="w-full h-12 rounded-full"
            >
              <View className="flex-row items-center gap-2">
                <Text className="text-base font-semibold text-primary-foreground">
                  Go to Alia
                </Text>
                <ArrowRight size={18} className="text-primary-foreground" />
              </View>
            </Button>
          </View>
        </AuthContainer>
      </>
    );
  }

  // Authenticated: show accept / result
  if (isAuthenticated) {
    return (
      <>
        <Head>
          <title>Join {orgName} - Alia</title>
          <meta name="description" content={`Join ${orgName} on Alia as a ${role}.`} />
        </Head>
        <AuthContainer>
          <View className="items-center gap-6">
            <View className="h-20 w-20 items-center justify-center rounded-full bg-primary/10">
              <Users size={40} className="text-primary" />
            </View>

            {accepted ? (
              <>
                <Text className="text-2xl font-bold text-foreground text-center">
                  You've joined {orgName}!
                </Text>
                <Text className="text-base text-muted-foreground text-center">
                  You're now a {role} of {orgName}.
                </Text>
                <Button
                  onPress={() => router.replace('/(app)')}
                  className="w-full h-12 rounded-full"
                >
                  <View className="flex-row items-center gap-2">
                    <Text className="text-base font-semibold text-primary-foreground">
                      Continue
                    </Text>
                    <ArrowRight size={18} className="text-primary-foreground" />
                  </View>
                </Button>
              </>
            ) : error ? (
              <>
                <Text className="text-2xl font-bold text-foreground text-center">
                  Couldn't join
                </Text>
                <Text className="text-base text-muted-foreground text-center">
                  {error}
                </Text>
                <Button
                  onPress={() => router.replace('/(app)')}
                  className="w-full h-12 rounded-full"
                >
                  <View className="flex-row items-center gap-2">
                    <Text className="text-base font-semibold text-primary-foreground">
                      Go to Alia
                    </Text>
                    <ArrowRight size={18} className="text-primary-foreground" />
                  </View>
                </Button>
              </>
            ) : (
              <>
                <Text className="text-2xl font-bold text-foreground text-center">
                  Join {orgName}
                </Text>
                <Text className="text-base text-muted-foreground text-center">
                  You've been invited to join as a {role}.
                </Text>
                <Button
                  onPress={handleAccept}
                  disabled={acceptMutation.isPending}
                  className="w-full h-12 rounded-full"
                >
                  <View className="flex-row items-center gap-2">
                    <Users size={18} className="text-primary-foreground" />
                    <Text className="text-base font-semibold text-primary-foreground">
                      {acceptMutation.isPending ? 'Joining...' : 'Accept & Join'}
                    </Text>
                  </View>
                </Button>
              </>
            )}
          </View>
        </AuthContainer>
      </>
    );
  }

  // Not authenticated: prompt to sign in
  return (
    <>
      <Head>
        <title>Join {orgName} - Alia</title>
        <meta name="description" content={`Sign in to join ${orgName} on Alia.`} />
      </Head>
      <AuthContainer>
        <View className="items-center gap-6">
          <View className="h-20 w-20 items-center justify-center rounded-full bg-primary/10">
            <Users size={40} className="text-primary" />
          </View>

          <Text className="text-2xl font-bold text-foreground text-center">
            Join {orgName}
          </Text>
          <Text className="text-base text-muted-foreground text-center">
            Sign in or create an account to join {orgName} as a {role}.
          </Text>

          <View className="w-full gap-3">
            <Button
              onPress={() => signIn().catch(() => {})}
              className="w-full h-12 rounded-full"
            >
              <View className="flex-row items-center gap-2">
                <Text className="text-base font-semibold text-primary-foreground">
                  Sign up & join
                </Text>
                <Users size={18} className="text-primary-foreground" />
              </View>
            </Button>

            <Button
              variant="outline"
              onPress={() => signIn().catch(() => {})}
              className="w-full h-12 rounded-full"
            >
              <View className="flex-row items-center gap-2">
                <LogIn size={18} className="text-foreground" />
                <Text className="text-base font-medium text-foreground">
                  Already have an account? Sign in
                </Text>
              </View>
            </Button>
          </View>
        </View>
      </AuthContainer>
    </>
  );
}
