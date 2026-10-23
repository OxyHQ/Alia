import { createHash } from 'node:crypto';
import { appCapabilityCatalogSchema, canonicalCapabilityJson } from '@oxy.so/contracts';

/** A valid registry wire row, with the same digest the registrar signs. */
export function registeredCatalog(input: unknown) {
  const catalog = appCapabilityCatalogSchema.parse(input);
  return {
    id: `registration-${catalog.appId}`,
    version: catalog.version,
    digest: createHash('sha256').update(canonicalCapabilityJson(catalog)).digest('hex'),
    catalog,
  };
}
