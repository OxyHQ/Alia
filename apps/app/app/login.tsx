import React, { useState } from 'react';
import { View, Text, Alert, Platform, Pressable } from 'react-native';
import { useRouter, Link } from 'expo-router';
import { AuthContainer, AuthLogo, AuthInput, AuthButton, AuthError } from '@/components/auth';
import { Button } from '@/components/ui/button';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { toast } from '@/components/sonner';
import apiClient from '@/lib/api/client';
import { useAuthStore } from '@/lib/stores/auth-store';

export default function LoginScreen() {
  const router = useRouter();
  const login = useAuthStore((state) => state.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async () => {
    setError('');

    if (!email.trim()) {
      const errorMsg = 'Please enter your email address';
      setError(errorMsg);
      if (Platform.OS !== 'web') {
        Alert.alert('Login Error', errorMsg);
      }
      return;
    }

    if (!password.trim()) {
      const errorMsg = 'Please enter your password';
      setError(errorMsg);
      if (Platform.OS !== 'web') {
        Alert.alert('Login Error', errorMsg);
      }
      return;
    }

    setLoading(true);

    try {
      // Call API login endpoint
      const response = await apiClient.post('/auth/login', {
        email: email.trim(),
        password,
      });

      const { user, token } = response.data;

      // Store user and token in auth store
      login(user, token);

      // Navigate to home screen
      router.replace('/');
    } catch (error: any) {
      console.error('Login error:', error);
      const errorMessage = error.response?.data?.error || 'Failed to login. Please try again.';
      setError(errorMessage);

      if (Platform.OS !== 'web') {
        Alert.alert('Login Failed', errorMessage);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSocialLogin = (provider: string) => {
    toast.info(`${provider.charAt(0).toUpperCase() + provider.slice(1)} login will be available soon`);
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

      {/* Login Form */}
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
          autoComplete="email"
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

        <View className="flex-row justify-end">
          <Link href="/(app)/forgot-password" asChild>
            <Pressable>
              <Text className="text-primary text-sm font-medium">Forgot password?</Text>
            </Pressable>
          </Link>
        </View>

        <AuthButton
          onPress={handleLogin}
          disabled={loading || !email || !password}
          isLoading={loading}
          loadingText="Signing in..."
        >
          Sign in
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
