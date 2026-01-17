import React, { useState, useEffect } from 'react';
import { View, Text } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { AuthContainer, AuthLogo, AuthInput, AuthButton, AuthError } from '@/components/auth';
import apiClient from '@/lib/api/client';
import { toast } from '@/components/sonner';

export default function ResetPasswordScreen() {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) {
      setError('Invalid or missing reset token');
    }
  }, [token]);

  const handleResetPassword = async () => {
    setError('');

    if (!password.trim()) {
      const errorMsg = 'Please enter a new password';
      setError(errorMsg);
      toast.error(errorMsg);
      return;
    }

    if (password.length < 8) {
      const errorMsg = 'Password must be at least 8 characters';
      setError(errorMsg);
      toast.error(errorMsg);
      return;
    }

    if (password !== confirmPassword) {
      const errorMsg = 'Passwords do not match';
      setError(errorMsg);
      toast.error(errorMsg);
      return;
    }

    setLoading(true);

    try {
      await apiClient.post('/auth/reset-password', {
        token,
        password,
      });

      toast.success('Your password has been reset successfully. Please sign in with your new password.');
      router.replace('/login');
    } catch (error: any) {
      console.error('Reset password error:', error);
      const errorMessage = error.response?.data?.error || 'Failed to reset password. Please try again.';
      setError(errorMessage);

      toast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthContainer>
      <AuthLogo />

      {/* Header */}
      <View className="space-y-2 mb-6">
        <Text className="text-3xl font-bold text-foreground tracking-tight">
          Create new password
        </Text>
        <Text className="text-base text-muted-foreground">
          Enter your new password
        </Text>
      </View>

      {/* Form */}
      <View className="gap-3">
        <AuthError message={error} />

        <AuthInput
          placeholder="New Password (min 8 characters)"
          value={password}
          onChangeText={(text) => {
            setPassword(text);
            setError('');
          }}
          secureTextEntry
          editable={!loading && !!token}
        />

        <AuthInput
          placeholder="Confirm New Password"
          value={confirmPassword}
          onChangeText={(text) => {
            setConfirmPassword(text);
            setError('');
          }}
          secureTextEntry
          editable={!loading && !!token}
          onSubmitEditing={handleResetPassword}
        />

        <AuthButton
          onPress={handleResetPassword}
          disabled={loading || !password || !confirmPassword || !token}
          isLoading={loading}
          loadingText="Resetting password..."
          className="mt-3"
        >
          Reset Password
        </AuthButton>
      </View>
    </AuthContainer>
  );
}
