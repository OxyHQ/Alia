import React, { useState } from 'react';
import { View, Text, Alert, Pressable } from 'react-native';
import { useRouter, Link } from 'expo-router';
import { AuthContainer, AuthLogo, AuthInput, AuthButton, AuthError } from '@/components/auth';
import apiClient from '@/lib/api/client';
import { useAuthStore } from '@/lib/stores/auth-store';

export default function LoginScreen() {
  const router = useRouter();
  // Use selector to avoid worklet serialization issues
  const login = useAuthStore((state) => state.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async () => {
    setLoading(true);
    setError('');

    try {
      // Call API login endpoint
      const response = await apiClient.post('/auth/login', {
        email: email.trim(),
        password,
      });

      const { user, token } = response.data;

      // Store user and token in auth store (persisted to AsyncStorage)
      login(user, token);

      // Navigate to home screen
      router.replace('/');
    } catch (error: any) {
      console.error('Login error:', error);
      const errorMessage = error.response?.data?.error || 'Failed to login. Please try again.';
      setError(errorMessage);

      // Also show alert on mobile
      if (Platform.OS !== 'web') {
        Alert.alert('Login Failed', errorMessage);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthContainer>
      <AuthLogo />

          {/* Header */}
          <View className="mb-6">
            <Text className="text-3xl font-bold text-foreground tracking-tight mb-1">
              Sign in
            </Text>
            <Text className="text-base text-muted-foreground">
              to continue to Alia
            </Text>
          </View>

          {/* Form */}
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
            />

            <AuthInput
              placeholder="Password"
              value={password}
              onChangeText={(text) => {
                setPassword(text);
                setError('');
              }}
              secureTextEntry
              editable={!loading}
              onSubmitEditing={handleLogin}
            />

            <Link href="/(app)/forgot-password" asChild>
              <Pressable className="self-end">
                <Text className="text-primary text-sm font-medium">
                  Forgot password?
                </Text>
              </Pressable>
            </Link>

            <AuthButton
              onPress={handleLogin}
              disabled={loading || !email || !password}
              isLoading={loading}
              loadingText="Signing in..."
              className="mt-3"
            >
              Continue
            </AuthButton>
          </View>

          {/* Footer */}
          <View className="mt-6">
            <View className="flex-row items-center justify-center gap-1">
              <Text className="text-muted-foreground text-sm">
                Don't have an account?
              </Text>
              <Link href="/(app)/register" asChild>
                <Pressable>
                  <Text className="text-primary text-sm font-medium">Sign up</Text>
                </Pressable>
              </Link>
            </View>
          </View>

          {/* Privacy note */}
          <View className="mt-8">
            <Text className="text-xs text-muted-foreground text-center leading-4">
              By continuing, you agree to Alia's Terms of Service and Privacy Policy
            </Text>
          </View>
    </AuthContainer>
  );
}
