import { AuthContainer } from '@/components/auth/auth-container';
import { AuthLogo } from '@/components/auth/auth-logo';
import { errorMessage } from '@/lib/errors/error-utils';
import {
  useAcceptOrgInvite,
  useOrgInviteInfo,
} from '@/lib/hooks/use-organization-invites';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiArrowRightLine } from '@oxy.so/bloom/icons/RiArrowRightLine';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { RiLoginBoxLine } from '@oxy.so/bloom/icons/RiLoginBoxLine';
import { RiTeamLine } from '@oxy.so/bloom/icons/RiTeamLine';
import { Loading } from '@oxy.so/bloom/loading';
import { useAuth } from '@oxy.so/services';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import React, { useState } from 'react';

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
        <Loading text="Loading..." />
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
          <EmptyState
            icon={RiErrorWarningLine}
            media="circle"
            title="Invite not found"
            description="This invitation link is invalid, expired, or has already been used."
            action={{
              label: 'Go to Alia',
              icon: RiArrowRightLine,
              onPress: () => router.replace('/(app)'),
            }}
          />
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
          {accepted ? (
            <EmptyState
              icon={RiTeamLine}
              media="circle"
              title={`You've joined ${orgName}!`}
              description={`You're now a ${role} of ${orgName}.`}
              action={{
                label: 'Continue',
                icon: RiArrowRightLine,
                onPress: () => router.replace('/(app)'),
              }}
            />
          ) : error ? (
            <EmptyState
              icon={RiTeamLine}
              media="circle"
              title="Couldn't join"
              description={error}
              action={{
                label: 'Go to Alia',
                icon: RiArrowRightLine,
                onPress: () => router.replace('/(app)'),
              }}
            />
          ) : (
            <EmptyState
              icon={RiTeamLine}
              media="circle"
              title={`Join ${orgName}`}
              description={`You've been invited to join as a ${role}.`}
              action={{
                label: acceptMutation.isPending ? 'Joining...' : 'Accept & Join',
                icon: RiTeamLine,
                onPress: handleAccept,
                disabled: acceptMutation.isPending,
                loading: acceptMutation.isPending,
              }}
            />
          )}
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
        <EmptyState
          icon={RiTeamLine}
          media="circle"
          title={`Join ${orgName}`}
          description={`Sign in or create an account to join ${orgName} as a ${role}.`}
          action={{
            label: 'Sign up & join',
            icon: RiTeamLine,
            onPress: () => signIn().catch(() => {}),
          }}
          secondaryAction={{
            label: 'Already have an account? Sign in',
            icon: RiLoginBoxLine,
            onPress: () => signIn().catch(() => {}),
          }}
        />
      </AuthContainer>
    </>
  );
}
