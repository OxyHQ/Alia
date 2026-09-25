import { AuthContainer } from '@/components/auth/auth-container';
import { AuthError } from '@/components/auth/auth-error';
import { AuthLogo } from '@/components/auth/auth-logo';
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';
import { useRequestPasswordReset } from '@/lib/hooks/auth/use-password-reset';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiMailCheckLine } from '@oxy.so/bloom/icons/RiMailCheckLine';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

export default function ForgotPasswordScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const requestReset = useRequestPasswordReset();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleResetPassword = async () => {
    if (!email.trim()) {
      setError(t('errors.emailRequired'));
      return;
    }

    setLoading(true);
    setError('');

    try {
      await requestReset.mutateAsync(email.trim());

      setSent(true);
      toast.success(t('forgotPassword.checkEmailToast'));
      router.back();
    } catch (error: unknown) {
      console.error('Reset password error:', error);
      const errorMessage = getErrorMessage(
        error,
        t('forgotPassword.failedToSend'),
      );
      setError(errorMessage);

      toast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthContainer>
      <AuthLogo />

      {sent ? (
        // Success state
        <EmptyState
          icon={RiMailCheckLine}
          media="circle"
          title={t('forgotPassword.checkEmail')}
          description={`${t('forgotPassword.sentInstructions')} ${email}`}
          action={{
            label: t('forgotPassword.returnToSignIn'),
            onPress: () => router.back(),
          }}
          secondaryAction={{
            label: t('forgotPassword.tryAnotherEmail'),
            onPress: () => {
              setSent(false);
              setEmail('');
            },
          }}
        />
      ) : (
        // Form state
        <View className="gap-6">
          <View className="gap-2">
            <Text variant="title-1-bold">{t('forgotPassword.title')}</Text>
            <Muted>{t('forgotPassword.subtitle')}</Muted>
          </View>

          <View className="gap-3">
            <AuthError message={error} />

            <TextFieldInput
              label={t('forgotPassword.emailPlaceholder')}
              placeholder={t('forgotPassword.emailPlaceholder')}
              value={email}
              onChangeText={(text) => {
                setEmail(text);
                setError('');
              }}
              autoCapitalize="none"
              keyboardType="email-address"
              editable={!loading}
              onSubmitEditing={handleResetPassword}
            />

            <Button
              tone="action"
              onPress={handleResetPassword}
              disabled={loading || !email}
              loading={loading}
            >
              {t('common.continue')}
            </Button>
          </View>
        </View>
      )}
    </AuthContainer>
  );
}
