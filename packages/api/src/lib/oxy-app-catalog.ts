/** Display name for a registered Oxy catalogue application. */
export function oxyAppDisplayName(appId: string): string {
  return appId.length === 0 ? appId : `${appId.charAt(0).toUpperCase()}${appId.slice(1)}`;
}
