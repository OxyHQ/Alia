import { preloadable, usePreloadWhenIdle } from '@/shared/platform/preloadable';
import { useDialogControl } from '@oxy.so/bloom/dialog';
import { useOxy } from '@oxy.so/services/ui/client';
import { Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AliaSettingsModalProps } from './alia-settings-modal';
import { SETTINGS_GROUPS } from './sections';
import { settingsPageIds } from './settings-pages';
import { AliaSettingsContext } from './settings-context';

/**
 * The modal and its pages, in their own chunk: mounted at the first `open()` and fetched before
 * that, once the page is idle, so opening it never waits.
 */
const AliaSettingsModal = preloadable<AliaSettingsModalProps>(() =>
  import('./alia-settings-modal').then((module) => module.AliaSettingsModal),
);

export function AliaSettingsProvider({ children }: { children: ReactNode }) {
  const control = useDialogControl();
  const { isAuthenticated } = useOxy();
  const [page, setPage] = useState('general');
  const [request, setRequest] = useState({
    sequence: 0,
    initialView: 'navigation' as 'navigation' | 'page',
  });
  const [params, setParams] = useState<Record<string, string>>({});
  const pending = useRef<(() => void) | null>(null);
  usePreloadWhenIdle(AliaSettingsModal);
  const open = useCallback(
    (next?: string, nextParams: Record<string, string> = {}) => {
      const target =
        next && settingsPageIds(SETTINGS_GROUPS, isAuthenticated).has(next) ? next : 'general';
      setPage(target);
      setParams(nextParams);
      setRequest((previous) => ({
        sequence: previous.sequence + 1,
        initialView: next ? 'page' : 'navigation',
      }));
    },
    [isAuthenticated],
  );
  const close = useCallback(() => control.close(), [control]);
  const afterClose = useCallback(
    (action: () => void) => {
      pending.current = action;
      control.close();
    },
    [control],
  );
  const onClose = useCallback(() => {
    const action = pending.current;
    pending.current = null;
    action?.();
  }, []);
  const value = useMemo(
    () => ({ open, close, afterClose, params }),
    [open, close, afterClose, params],
  );
  return (
    <AliaSettingsContext.Provider value={value}>
      {children}
      {request.sequence > 0 ? (
        <Suspense fallback={null}>
          <AliaSettingsModal
            control={control}
            isAuthenticated={isAuthenticated}
            page={page}
            onPageChange={setPage}
            initialView={request.initialView}
            openSequence={request.sequence}
            onClose={onClose}
          />
        </Suspense>
      ) : null}
    </AliaSettingsContext.Provider>
  );
}
