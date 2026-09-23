import { createContext, useContext } from 'react';
export interface AliaSettingsActions {
  open: (page?: string, params?: Record<string, string>) => void;
  close: () => void;
  afterClose: (action: () => void) => void;
  params: Record<string, string>;
}
export const AliaSettingsContext = createContext<AliaSettingsActions | null>(
  null,
);
export function useAliaSettings() {
  const value = useContext(AliaSettingsContext);
  if (!value) throw new Error('AliaSettingsProvider is required');
  return value;
}
