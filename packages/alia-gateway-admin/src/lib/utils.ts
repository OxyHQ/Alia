import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Extracts a human-readable message from an unknown error, supporting both
 * Axios-style `{ response: { data: { error } } }` shapes and plain `Error`.
 */
export function getErrorMessage(err: unknown, fallback = 'Request failed'): string {
  if (typeof err === 'object' && err !== null) {
    const maybeAxios = err as {
      response?: { data?: { error?: string; message?: string } };
      message?: string;
    };
    const responseError =
      maybeAxios.response?.data?.error ?? maybeAxios.response?.data?.message;
    if (responseError) return responseError;
    if (maybeAxios.message) return maybeAxios.message;
  }
  if (typeof err === 'string') return err;
  return fallback;
}
