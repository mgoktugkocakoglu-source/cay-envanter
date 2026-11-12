import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CombinedSeasonFile } from '../cli/combine-pruning.ts';

/**
 * The optional `pruningCombined` block of the site bundle: per season, one verdict per garden from the
 * multi-sensor module and the pixel scan together (class, agreement, date bracket, square metres, producer
 * roll-up). Produced by `combine-pruning`; it reads the two modules' outputs and changes neither.
 */
export function loadCombinedForBundle(neighborhoodDir: string) {
    const dir = join(neighborhoodDir, 'pruning-combined');
    if (!existsSync(dir)) return null;
    const seasons = readdirSync(dir)
        .filter((n) => /^season-\d{4}-\d{2}\.json$/.test(n))
        .sort()
        .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as CombinedSeasonFile);
    return seasons.length ? { seasons } : null;
}
