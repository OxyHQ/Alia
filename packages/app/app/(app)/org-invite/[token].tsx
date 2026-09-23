import { AuthContainer } from '@/components/auth/auth-container';
import { AuthLogo } from '@/components/auth/auth-logo';
import { errorMessage } from '@/lib/errors/error-utils';
import {
  useAcceptOrgInvite,
  useOrgInviteInfo,
} from '@/lib/hooks/use-organization-invites';
import { Button } from '@oxy.so/bloom/button';
import { ContentPanel } from '@oxy.so/bloom/content-panel';
import { Text } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { AlertCircle, ArrowRight, LogIn, Users } from 'lucide-react-native';
import React, { useState } from 'react';
import { View } from 'react-native';

export default function OrgInviteScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading, signIn } = useAuth();
  const {
    data: inviteData,
    isLoading: infoLoading,
    error: infoError,
  } = useOrgInviteInfo(token || '');
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
        setError(errorMessage(err, 'Failed to accept invitation'));
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
              This invitation link is invalid, expired, or has already been
              used.
            </Text>
            <Button
              onPress={() => router.replace('/(app)')}
              className="w-full h-12 rounded-full"
              leading={
                <>
                  <ArrowRight size={18} className="text-primary-foreground" />
                </>
              }
            >
              Go to Alia
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
          <meta
            name="description"
            content={`Join ${orgName} on Alia as a ${role}.`}
          />
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
                  leading={
                    <>
                      <ArrowRight
                        size={18}
                        className="text-primary-foreground"
                      />
                    </>
                  }
                >
                  Continue
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
                  leading={
                    <>
                      <ArrowRight
                        size={18}
                        className="text-primary-foreground"
                      />
                    </>
                  }
                >
                  Go to Alia
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
                  leading={
                    <>
                      <Users size={18} className="text-primary-foreground" />
                    </>
                  }
                >
                  {acceptMutation.isPending ? 'Joining...' : 'Accept & Join'}
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
    <ContentPanel surfaceClassName="bg-background">
      <>
        <Head>
          <title>Join {orgName} - Alia</title>
          <meta
            name="description"
            content={`Sign in to join ${orgName} on Alia.`}
          />
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
                leading={
                  <>
                    <Users size={18} className="text-primary-foreground" />
                  </>
                }
              >
                Sign up & join
              </Button>

              <Button
                variant="secondary"
                onPress={() => signIn().catch(() => {})}
                className="w-full h-12 rounded-full"
                leading={
                  <>
                    <LogIn size={18} className="text-foreground" />
                  </>
                }
              >
                Already have an account? Sign in
              </Button>
            </View>
          </View>
        </AuthContainer>
      </>
    </ContentPanel>
  );
}
