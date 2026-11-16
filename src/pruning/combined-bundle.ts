import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CombinedSeasonFile } from '../cli/combine-pruning.ts';
import type { HistoryFile } from '../cli/check-pruning-history.ts';

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
    // Retrospective check and multi-year roll-up (pruning-history); absent until it has run.
    const historyPath = join(dir, 'history.json');
    const stored = existsSync(historyPath) ? (JSON.parse(readFileSync(historyPath, 'utf8')) as HistoryFile) : null;
    // The retrospective check is shown only when it is newer than every season file it reads (pruning-history reruns after combine-pruning).
    const history = stored && seasons.every((s) => s.generatedAt <= stored.generatedAt) ? stored : null;
    return seasons.length ? { seasons, history } : null;
}
