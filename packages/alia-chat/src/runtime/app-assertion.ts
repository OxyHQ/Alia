// `@oxy.so/services/ui`, not the root barrel (which ships the sign-in panels, `check:entries`):
// `ui/client` does not export `useAppAssertion`.
import { useAppAssertion } from '@oxy.so/services/ui';
import { useMemo } from 'react';

/**
 * Which Oxy app this conversation is in, for Alia (Alia ADR 0021, Oxy ADR 0045).
 *
 * An Oxy app may confine its own agent to itself — Clarity's assistant opens
 * only inside Clarity — and the official apps share one session that names no
 * app, so Alia reads the app from the Oxy-signed assertion the host's
 * `OxyProvider` obtains and keeps current. Every request the SDK makes to Alia
 * carries it as `X-Oxy-App-Assertion` when there is one; without one (an app
 * Oxy cannot recognise yet, a signed-out person) nothing is sent, and only a
 * confined agent is affected.
 *
 * The SDK never builds, stores or inspects the assertion: it is the host's
 * provider's, read at send time so it is never stale.
 */
export type AppAssertionHeaders = () => Promise<Record<string, string>>;

/** No app assertion: what a caller outside a React tree, or a test, passes. */
export const NO_APP_ASSERTION: AppAssertionHeaders = async () => ({});

/** The host's app assertion as request headers, `{}` when it has none or cannot get one. */
export function useAppAssertionHeaders(): AppAssertionHeaders {
  const { getAppAssertionHeaders } = useAppAssertion();
  return useMemo(
    () => async () => {
      try {
        return await getAppAssertionHeaders();
      } catch {
        return {};
      }
    },
    [getAppAssertionHeaders],
  );
}

/** The host's app assertion itself, for the voice socket, which cannot carry a header. */
export function useAppAssertionToken(): () => Promise<string | null> {
  const { getAppAssertion } = useAppAssertion();
  return useMemo(
    () => async () => {
      try {
        return await getAppAssertion();
      } catch {
        return null;
      }
    },
    [getAppAssertion],
  );
}
