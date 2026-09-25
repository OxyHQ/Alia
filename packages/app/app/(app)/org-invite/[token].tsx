import { AuthContainer } from '@/components/auth/auth-container';
import { AuthLogo } from '@/components/auth/auth-logo';
import { errorMessage } from '@/lib/errors/error-utils';
import {
  useAcceptOrgInvite,
  useOrgInviteInfo,
} from '@/lib/hooks/use-organization-invites';
import { useTranslation } from '@/lib/hooks/use-translation';
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
  const { t } = useTranslation();

  const orgName =
    inviteData?.invite?.organization?.name || t('orgInvite.thisOrganization');
  const rawRole = inviteData?.invite?.role || 'member';
  // The roles the API issues have words of their own; anything else is shown
  // as the API spelled it rather than as a guessed key.
  const role = ['owner', 'admin', 'member'].includes(rawRole)
    ? t(`orgInvite.role.${rawRole}`)
    : rawRole;

  const handleAccept = React.useCallback(() => {
    if (!token) return;
    acceptMutation.mutate(token, {
      onSuccess: () => setAccepted(true),
      onError: (err: any) => {
        setError(errorMessage(err, t('orgInvite.acceptFailed')));
      },
    });
  }, [token, acceptMutation, t]);

  if (authLoading || infoLoading) {
    return (
      <AuthContainer>
        <AuthLogo />
        <Loading text={t('common.loading')} />
      </AuthContainer>
    );
  }

  // Invite not found / expired
  if (infoError || (!infoLoading && !inviteData)) {
    return (
      <>
        <Head>
          <title>{t('orgInvite.invalidTitle')}</title>
        </Head>
        <AuthContainer>
          <EmptyState
            icon={RiErrorWarningLine}
            media="circle"
            title={t('orgInvite.notFound')}
            description={t('orgInvite.notFoundDescription')}
            action={{
              label: t('invitePage.goToAlia'),
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
          <title>{t('orgInvite.pageTitle', { org: orgName })}</title>
          <meta
            name="description"
            content={t('orgInvite.metaJoin', { org: orgName, role })}
          />
        </Head>
        <AuthContainer>
          {accepted ? (
            <EmptyState
              icon={RiTeamLine}
              media="circle"
              title={t('orgInvite.joined', { org: orgName })}
              description={t('orgInvite.joinedDescription', {
                org: orgName,
                role,
              })}
              action={{
                label: t('common.continue'),
                icon: RiArrowRightLine,
                onPress: () => router.replace('/(app)'),
              }}
            />
          ) : error ? (
            <EmptyState
              icon={RiTeamLine}
              media="circle"
              title={t('orgInvite.joinFailed')}
              description={error}
              action={{
                label: t('invitePage.goToAlia'),
                icon: RiArrowRightLine,
                onPress: () => router.replace('/(app)'),
              }}
            />
          ) : (
            <EmptyState
              icon={RiTeamLine}
              media="circle"
              title={t('orgInvite.join', { org: orgName })}
              description={t('orgInvite.invitedAs', { role })}
              action={{
                label: acceptMutation.isPending
                  ? t('orgInvite.joining')
                  : t('orgInvite.accept'),
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
        <title>{t('orgInvite.pageTitle', { org: orgName })}</title>
        <meta
          name="description"
          content={t('orgInvite.metaSignIn', { org: orgName })}
        />
      </Head>
      <AuthContainer>
        <EmptyState
          icon={RiTeamLine}
          media="circle"
          title={t('orgInvite.join', { org: orgName })}
          description={t('orgInvite.signInDescription', {
            org: orgName,
            role,
          })}
          action={{
            label: t('orgInvite.signUp'),
            icon: RiTeamLine,
            onPress: () => signIn().catch(() => {}),
          }}
          secondaryAction={{
            label: t('invitePage.signIn'),
            icon: RiLoginBoxLine,
            onPress: () => signIn().catch(() => {}),
          }}
        />
      </AuthContainer>
    </>
  );
}
