import { useTranslation } from '@/shared/i18n/use-translation';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { ErrorBoundary } from '@oxy.so/bloom/error-boundary';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { Screen } from '@oxy.so/bloom/screen';
import React from 'react';
import { View } from 'react-native';

interface AppErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional fallback component. If not provided, the default error screen is used. */
  fallback?: React.ComponentType<{ error: Error; resetError: () => void }>;
}

/** Report a render error to Sentry when it is installed, and to the console in development. */
function reportError(error: Error, errorInfo: React.ErrorInfo) {
  try {
    const Sentry = require('@sentry/react-native');
    Sentry.captureException(error, {
      contexts: {
        react: {
          componentStack: errorInfo.componentStack ?? undefined,
        },
      },
    });
  } catch {
    // Sentry not installed — skip
  }

  if (__DEV__) {
    console.error('AppErrorBoundary caught an error:', error, errorInfo);
  }
}

/**
 * Bloom's `ErrorBoundary`, with Alia's reporting and a themed recovery screen.
 *
 * The fallback is Bloom's `EmptyState` on a `Screen`, so it paints in the
 * theme rather than in the boundary's literal white. The error message itself
 * is never shown: it is written for us and cannot be acted on.
 */
export function AppErrorBoundary({ children, fallback: Fallback }: AppErrorBoundaryProps) {
  return (
    <ErrorBoundary
      onError={reportError}
      fallback={({ error, retry }) =>
        Fallback ? <Fallback error={error} resetError={retry} /> : <ErrorFallback onRetry={retry} />
      }
    >
      {children}
    </ErrorBoundary>
  );
}

/** Default full-screen error fallback UI. */
function ErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Screen>
      <View className="flex-1 items-center justify-center p-6">
        <EmptyState
          icon={RiErrorWarningLine}
          media="circle"
          title={t('dialogs.errorBoundary.title')}
          description={t('dialogs.errorBoundary.message')}
          action={{ label: t('common.tryAgain'), onPress: onRetry }}
        />
      </View>
    </Screen>
  );
}
