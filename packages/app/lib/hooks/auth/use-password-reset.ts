import apiClient from '@/lib/api/client';
import { API_ROUTES } from '@/lib/api/routes';
import { useMutation } from '@tanstack/react-query';

/** Ask for a reset link to be mailed to `email`. */
export function useRequestPasswordReset() {
  return useMutation({
    mutationFn: async (email: string) => {
      await apiClient.post(API_ROUTES.auth.forgotPassword, { email });
    },
  });
}

/** Set a new password with the token from the reset link. */
export function useResetPassword() {
  return useMutation({
    mutationFn: async (input: { token: string | undefined; password: string }) => {
      await apiClient.post(API_ROUTES.auth.resetPassword, input);
    },
  });
}
