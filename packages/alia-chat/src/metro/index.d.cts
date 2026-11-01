/** Wrap an existing Metro config without replacing its previous resolver. */
export function withAliaGranularCharts<T extends { resolver?: object }>(
  config: T,
  options?: { additionalSdkRoots?: string[] },
): T;
