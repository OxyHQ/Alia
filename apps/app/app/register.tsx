import React, { useState } from 'react';
import { View, Text, KeyboardAvoidingView, Platform, ScrollView, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text as UIText } from '@/components/ui/text';
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

      // Navigate to chat screen
      router.replace('/(chat)');
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
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="mb-8">
          <Text className="text-4xl font-bold text-foreground mb-2">
            Crear Cuenta
          </Text>
          <Text className="text-muted-foreground text-base">
            Regístrate para comenzar
          </Text>
        </View>

        <View className="space-y-4">
          {error ? (
            <View className="bg-destructive/10 border border-destructive rounded-lg p-3">
              <Text className="text-destructive text-sm">{error}</Text>
            </View>
          ) : null}

          <View>
            <Text className="text-sm font-medium text-foreground mb-2">
              First Name
            </Text>
            <Input
              placeholder="John"
              value={firstName}
              onChangeText={(text) => {
                setFirstName(text);
                setError('');
              }}
              autoCapitalize="words"
              editable={!loading}
            />
          </View>

          <View>
            <Text className="text-sm font-medium text-foreground mb-2">
              Last Name (Optional)
            </Text>
            <Input
              placeholder="Doe"
              value={lastName}
              onChangeText={(text) => {
                setLastName(text);
                setError('');
              }}
              autoCapitalize="words"
              editable={!loading}
            />
          </View>

          <View>
            <Text className="text-sm font-medium text-foreground mb-2">
              Email
            </Text>
            <Input
              placeholder="john@example.com"
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
          </View>

          <View>
            <Text className="text-sm font-medium text-foreground mb-2">
              Password (min 8 characters)
            </Text>
            <Input
              placeholder="••••••••"
              value={password}
              onChangeText={(text) => {
                setPassword(text);
                setError('');
              }}
              secureTextEntry
              editable={!loading}
            />
          </View>

          <View>
            <Text className="text-sm font-medium text-foreground mb-2">
              Confirm Password
            </Text>
            <Input
              placeholder="••••••••"
              value={confirmPassword}
              onChangeText={(text) => {
                setConfirmPassword(text);
                setError('');
              }}
              secureTextEntry
              editable={!loading}
              onSubmitEditing={handleRegister}
            />
          </View>

          <Button
            onPress={handleRegister}
            disabled={loading || !email || !password || !firstName}
            className="mt-6"
          >
            <UIText>{loading ? 'Creating account...' : 'Sign up'}</UIText>
          </Button>

          <Button
            variant="ghost"
            onPress={() => router.back()}
            className="mt-2"
          >
            <Text className="text-muted-foreground text-center">
              ¿Ya tienes cuenta?{' '}
              <Text className="text-primary font-semibold">Inicia Sesión</Text>
            </Text>
          </Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
