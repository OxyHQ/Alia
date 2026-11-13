import type { SettingsSection } from './sections';

/** Signed out, settings show General only: every other page is the account's. */
export function visibleSettingsSections(
  sections: readonly SettingsSection[],
  isAuthenticated: boolean,
): SettingsSection[] {
  return sections.filter((section) => isAuthenticated || section.id === 'general');
}

/**
 * The pages the settings modal can open on: the visible sections, and, signed in, a connector's
 * detail page (which no navigation item leads to).
 */
export function settingsPageIds(
  groups: readonly { sections: readonly SettingsSection[] }[],
  isAuthenticated: boolean,
): ReadonlySet<string> {
  const ids = groups.flatMap((group) =>
    visibleSettingsSections(group.sections, isAuthenticated).map((section) => section.id),
  );
  return new Set(isAuthenticated ? [...ids, 'connector-detail'] : ids);
}
