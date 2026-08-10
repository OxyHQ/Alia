import type { AuditCheck } from './types';
import { danglingReferencesCheck } from './checks/dangling-references';

/**
 * Every check the runner knows about.
 *
 * ONE today, deliberately. `db/schema/CONVENTIONS.md` holds roughly fifteen
 * audit items across batches 3, 4, 6, 8 and 9, and this module exists so the
 * PATTERN is a working example rather than a description — the remaining checks
 * are specified in `docs/backfill-audit.md` and are somebody else's to write,
 * with full attention on the queries.
 *
 * The shipped one is the `23503` dangling-reference count: the finding with
 * teeth, and the shape every other blocking check copies.
 */
export const AUDIT_CHECKS: readonly AuditCheck[] = [danglingReferencesCheck];
