import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComplianceFile } from './model.ts';

/** The optional `compliance` block of the site bundle (check-compliance). Absent until the report has been built. */
export function loadComplianceForBundle(neighborhoodDir: string): ComplianceFile | null {
    const path = join(neighborhoodDir, 'compliance', 'report.json');
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ComplianceFile) : null;
}
