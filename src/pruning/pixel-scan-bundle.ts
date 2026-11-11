import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PixelSeasonFile } from '../cli/scan-pixels.ts';

/**
 * The optional `pixelScan` block of the site bundle: per season, the lattice-level undated pruning scan of
 * every garden (verdict, date bracket, clusters, pixels, recovery series). Produced by `scan-pixels`,
 * separate from the fusion verdicts.
 */
export function loadPixelScanForBundle(neighborhoodDir: string) {
    const dir = join(neighborhoodDir, 'pruning-pixels');
    if (!existsSync(dir)) return null;
    const seasons = readdirSync(dir)
        .filter((n) => /^season-\d{4}-\d{2}\.json$/.test(n))
        .sort()
        .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as PixelSeasonFile);
    return seasons.length ? { seasons } : null;
}
