import React, { useState } from 'react';
import { View, Text, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { AuthContainer, AuthLogo, AuthInput, AuthButton, AuthError } from '@/components/auth';
import { Button } from '@/components/ui/button';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import apiClient from '@/lib/api/client';
import { useAuthStore } from '@/lib/stores/auth-store';

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleContinue = async () => {
    if (!email.trim()) {
      setError('Please enter your email address');
      return;
    }

    // For now, navigate to a password screen or implement passwordless flow
    // This is a placeholder - you'll need to implement the actual auth flow
    setLoading(true);
    setError('');

    try {
      // TODO: Implement email continuation logic
      // This could be passwordless magic link or navigate to password screen
      console.log('Continue with email:', email);
    } catch (error: any) {
      console.error('Login error:', error);
      setError('Failed to continue. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSocialLogin = (provider: string) => {
    // TODO: Implement social login
    console.log('Login with', provider);
  };

  return (
    <AuthContainer>
      <AuthLogo />

      {/* Header */}
      <View className="space-y-2 mb-6">
        <Text className="text-3xl font-bold text-foreground tracking-tight">
          Sign in or sign up
        </Text>
        <Text className="text-base text-muted-foreground">
          to continue to Alia
        </Text>
      </View>

      {/* Social Login Buttons */}
      <View className="gap-2 mb-4">
        <Button
          variant="outline"
          onPress={() => handleSocialLogin('google')}
          className="h-11 rounded-full"
        >
          <View className="flex-row items-center gap-2">
            <MaterialCommunityIcons name="google" size={18} color="#0F172A" />
            <Text className="text-sm font-medium">Continue with Google</Text>
          </View>
        </Button>

        <Button
          variant="outline"
          onPress={() => handleSocialLogin('microsoft')}
          className="h-11 rounded-full"
        >
          <View className="flex-row items-center gap-2">
            <MaterialCommunityIcons name="microsoft" size={18} color="#0F172A" />
            <Text className="text-sm font-medium">Continue with Microsoft</Text>
          </View>
        </Button>

        <Button
          variant="outline"
          onPress={() => handleSocialLogin('apple')}
          className="h-11 rounded-full"
        >
          <View className="flex-row items-center gap-2">
            <MaterialCommunityIcons name="apple" size={18} color="#0F172A" />
            <Text className="text-sm font-medium">Continue with Apple</Text>
          </View>
        </Button>
      </View>

      {/* Divider */}
      <View className="flex-row items-center gap-3 mb-4">
        <View className="flex-1 h-px bg-border" />
        <Text className="text-sm text-muted-foreground">OR</Text>
        <View className="flex-1 h-px bg-border" />
      </View>

      {/* Email Form */}
      <View className="gap-2">
        <AuthError message={error} />

        <AuthInput
          placeholder="Enter your email address"
          value={email}
          onChangeText={(text) => {
            setEmail(text);
            setError('');
          }}
          autoCapitalize="none"
          keyboardType="email-address"
          editable={!loading}
          onSubmitEditing={handleContinue}
        />

        <AuthButton
          onPress={handleContinue}
          disabled={loading || !email}
          isLoading={loading}
          loadingText="Continuing..."
          className="mt-1"
        >
          Continue
        </AuthButton>
      </View>

      {/* Privacy note */}
      <View className="mt-6">
        <Text className="text-xs text-muted-foreground text-center leading-4">
          By continuing, you agree to Alia's Terms of Service and Privacy Policy
        </Text>
      </View>
    </AuthContainer>
  );
}
