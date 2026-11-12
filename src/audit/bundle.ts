import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditFile } from '../cli/audit-licensing.ts';

/**
 * The optional `licenceAudit` block of the site bundle: per parcel, the deed title, the licence register and the
 * title-independent detection bound to one decision (audit-licensing). Absent until the audit has run.
 */
export function loadLicenceAuditForBundle(neighborhoodDir: string): AuditFile | null {
    const path = join(neighborhoodDir, 'licence-audit', 'audit.json');
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as AuditFile) : null;
}
