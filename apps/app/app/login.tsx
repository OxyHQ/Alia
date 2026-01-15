import React, { useState } from 'react';
import { View, Text, KeyboardAvoidingView, Platform, ScrollView, Alert } from 'react-native';
import { useRouter, Link } from 'expo-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

      // Navigate to chat screen
      router.replace('/(chat)');
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
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-background"
    >
      <ScrollView
        className="flex-1"
        contentContainerClassName="flex-1 justify-center p-6"
        keyboardShouldPersistTaps="handled"
      >
        <View className="max-w-md w-full mx-auto gap-6">
          {/* Header */}
          <View className="gap-2">
            <Text className="text-3xl font-bold text-foreground">
              Welcome back
            </Text>
            <Text className="text-muted-foreground">
              Sign in to your account to continue
            </Text>
          </View>

          {/* Form */}
          <View className="gap-4">
            {error ? (
              <View className="bg-destructive/10 border border-destructive rounded-lg p-3">
                <Text className="text-destructive text-sm">{error}</Text>
              </View>
            ) : null}

            <View className="gap-2">
              <Label>Email</Label>
              <Input
                placeholder="m@example.com"
                value={email}
                onChangeText={(text) => {
                  setEmail(text);
                  setError('');
                }}
                autoCapitalize="none"
                keyboardType="email-address"
                editable={!loading}
              />
            </View>

            <View className="gap-2">
              <Label>Password</Label>
              <Input
                placeholder="Enter your password"
                value={password}
                onChangeText={(text) => {
                  setPassword(text);
                  setError('');
                }}
                secureTextEntry
                editable={!loading}
                onSubmitEditing={handleLogin}
              />
            </View>

            <Button
              onPress={handleLogin}
              disabled={loading || !email || !password}
              className="mt-2"
            >
              <Text className={loading ? "text-muted" : ""}>
                {loading ? 'Signing in...' : 'Sign in'}
              </Text>
            </Button>
          </View>

          {/* Footer */}
          <View className="flex-row items-center justify-center gap-1">
            <Text className="text-muted-foreground">
              Don't have an account?
            </Text>
            <Link href="/register" asChild>
              <Button variant="link" className="p-0 h-auto">
                <Text>Sign up</Text>
              </Button>
            </Link>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
