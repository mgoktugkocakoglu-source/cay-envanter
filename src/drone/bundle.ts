import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DroneVerificationFile } from './model.ts';

/**
 * The optional `droneVerification` block of the site bundle (verify-drone), with the evidence images the site
 * serves as static files under <imageryBaseUrl>. Absent until a drone project has been analysed.
 */
export function loadDroneForBundle(neighborhoodDir: string): { block: DroneVerificationFile; evidence: Array<{ project: string; dir: string; files: string[] }> } | null {
    const path = join(neighborhoodDir, 'drone', 'verification.json');
    if (!existsSync(path)) return null;
    const block = JSON.parse(readFileSync(path, 'utf8')) as DroneVerificationFile;
    const evidence = block.sources.map((s) => {
        const dir = join(neighborhoodDir, 'drone', 'evidence', s.id);
        return { project: s.id, dir, files: existsSync(dir) ? readdirSync(dir).filter((f) => /\.(jpe?g|mp4)$/i.test(f)) : [] };
    });
    return { block, evidence };
}
