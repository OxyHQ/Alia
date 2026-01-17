import React, { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { AuthContainer, AuthLogo, AuthInput, AuthButton, AuthError } from '@/components/auth';
import apiClient from '@/lib/api/client';
import { toast } from '@/components/sonner';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleResetPassword = async () => {
    if (!email.trim()) {
      setError('Please enter your email address');
      return;
    }

    setLoading(true);
    setError('');

    try {
      // Call API reset password endpoint
      await apiClient.post('/auth/forgot-password', {
        email: email.trim(),
      });

      setSent(true);
      toast.success('Check your email for instructions to reset your password.');
      router.back();
    } catch (error: any) {
      console.error('Reset password error:', error);
      const errorMessage = error.response?.data?.error || 'Failed to send reset email. Please try again.';
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
            // Success State
            <View className="items-center">
              <Text className="text-2xl font-bold text-foreground tracking-tight mb-2 text-center">
                Check your email
              </Text>
              <Text className="text-sm text-muted-foreground text-center mb-6 leading-5">
                We've sent password reset instructions to{'\n'}
                <Text className="font-medium text-foreground">{email}</Text>
              </Text>
              <AuthButton
                onPress={() => router.back()}
                className="w-full"
              >
                Return to Sign in
              </AuthButton>
              <Pressable
                onPress={() => {
                  setSent(false);
                  setEmail('');
                }}
                className="mt-4"
              >
                <Text className="text-primary text-sm font-medium">
                  Try another email
                </Text>
              </Pressable>
            </View>
      ) : (
        // Form State
        <>
          <View className="space-y-2 mb-6">
            <Text className="text-3xl font-bold text-foreground tracking-tight">
              Reset password
            </Text>
            <Text className="text-base text-muted-foreground">
              Enter your email to reset your password
            </Text>
          </View>

          <View className="gap-3">
            <AuthError message={error} />

            <AuthInput
              placeholder="Email"
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

            <AuthButton
              onPress={handleResetPassword}
              disabled={loading || !email}
              isLoading={loading}
              loadingText="Sending..."
              className="mt-3"
            >
              Continue
            </AuthButton>
          </View>
        </>
      )}

    </AuthContainer>
  );
}
