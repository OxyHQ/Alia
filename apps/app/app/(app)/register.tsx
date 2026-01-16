import React, { useState } from 'react';
import { View, Text, Alert, Pressable, Platform } from 'react-native';
import { useRouter, Link } from 'expo-router';
import { AuthContainer, AuthLogo, AuthInput, AuthButton, AuthError } from '@/components/auth';
import apiClient from '@/lib/api/client';
import { useAuthStore } from '@/lib/stores/auth-store';

export default function RegisterScreen() {
  const router = useRouter();
  // Use selector to avoid worklet serialization issues
  const login = useAuthStore((state) => state.login);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleRegister = async () => {
    setError('');

    // Validate passwords match
    if (password !== confirmPassword) {
      const errorMsg = 'Passwords do not match';
      setError(errorMsg);
      if (Platform.OS !== 'web') {
        Alert.alert('Registration Error', errorMsg);
      }
      return;
    }

    // Validate password length
    if (password.length < 8) {
      const errorMsg = 'Password must be at least 8 characters';
      setError(errorMsg);
      if (Platform.OS !== 'web') {
        Alert.alert('Registration Error', errorMsg);
      }
      return;
    }

    setLoading(true);
    try {
      // Call API register endpoint
      const response = await apiClient.post('/auth/register', {
        email: email.trim(),
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
      });

      const { user, token } = response.data;

      // Store user and token in auth store (persisted to AsyncStorage)
      login(user, token);

      // Navigate to home screen
      router.replace('/');
    } catch (error: any) {
      console.error('Register error:', error);
      const errorMessage = error.response?.data?.error || 'Failed to register. Please try again.';
      setError(errorMessage);

      // Also show alert on mobile
      if (Platform.OS !== 'web') {
        Alert.alert('Registration Failed', errorMessage);
      }
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
          Create Account
        </Text>
        <Text className="text-base text-muted-foreground">
          Sign up to get started
        </Text>
      </View>

      {/* Form */}
      <View className="gap-3">
            <AuthError message={error} />

            <AuthInput
              placeholder="First Name"
              value={firstName}
              onChangeText={(text) => {
                setFirstName(text);
                setError('');
              }}
              autoCapitalize="words"
              editable={!loading}
            />

            <AuthInput
              placeholder="Last Name (Optional)"
              value={lastName}
              onChangeText={(text) => {
                setLastName(text);
                setError('');
              }}
              autoCapitalize="words"
              editable={!loading}
            />

            <AuthInput
              placeholder="Email"
              value={email}
              onChangeText={(text) => {
                setEmail(text);
                setError('');
              }}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              editable={!loading}
            />

            <AuthInput
              placeholder="Password (min 8 characters)"
              value={password}
              onChangeText={(text) => {
                setPassword(text);
                setError('');
              }}
              secureTextEntry
              editable={!loading}
            />

            <AuthInput
              placeholder="Confirm Password"
              value={confirmPassword}
              onChangeText={(text) => {
                setConfirmPassword(text);
                setError('');
              }}
              secureTextEntry
              editable={!loading}
              onSubmitEditing={handleRegister}
            />

        <AuthButton
          onPress={handleRegister}
          disabled={loading || !email || !password || !firstName}
          isLoading={loading}
          loadingText="Creating account..."
          className="mt-3"
        >
          Continue
        </AuthButton>
      </View>

      {/* Footer */}
      <View className="mt-6">
        <View className="flex-row items-center justify-center gap-1">
          <Text className="text-muted-foreground text-sm">
            Already have an account?
          </Text>
          <Link href="/(app)/login" asChild>
            <Pressable>
              <Text className="text-primary text-sm font-medium">Sign in</Text>
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
