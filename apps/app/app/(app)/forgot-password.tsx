import React, { useState } from 'react';
import { View, Text, Platform, Alert, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { AuthContainer, AuthInput, AuthButton, AuthError } from '@/components/auth';
import { Mail } from 'lucide-react-native';
import apiClient from '@/lib/api/client';

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

      if (Platform.OS !== 'web') {
        Alert.alert(
          'Email Sent',
          'Check your email for instructions to reset your password.',
          [{ text: 'OK', onPress: () => router.back() }]
        );
      }
    } catch (error: any) {
      console.error('Reset password error:', error);
      const errorMessage = error.response?.data?.error || 'Failed to send reset email. Please try again.';
      setError(errorMessage);

      if (Platform.OS !== 'web') {
        Alert.alert('Error', errorMessage);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthContainer>
      {/* Mail Icon - unique to forgot password */}
      <View className="items-center mb-8">
        <View className="w-28 h-28 rounded-full bg-primary/10 items-center justify-center mb-4">
          <Mail size={44} className="text-primary" />
        </View>
      </View>

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
              <View className="mb-6">
                <Text className="text-3xl font-bold text-foreground tracking-tight mb-1">
                  Reset password
                </Text>
                <Text className="text-sm text-muted-foreground leading-5">
                  Enter your email address and we'll send you instructions to reset your password
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
                  className="mt-2"
                >
                  Continue
                </AuthButton>
              </View>
            </>
          )}

      {/* Privacy note */}
      {!sent && (
        <View className="mt-8">
          <Text className="text-xs text-muted-foreground text-center leading-4">
            This is a secure page. We protect your information.
          </Text>
        </View>
      )}
    </AuthContainer>
  );
}
