import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LandEvaluationFile } from '../cli/evaluate-land.ts';

/**
 * The optional `land` block of the site bundle: Toprak Koruma ve Arazi Değerlendirme — per-parcel
 * terrain, soil, land use (declared vs observed, yearly history, Landsat NDVI since 1986), erosion,
 * capability class (AKK proxy), 5403 class suggestion, cited crop suitability and recommendations, plus
 * the neighbourhood climate record (MGM-anchored), the evidence registry, stations and district facts.
 */
export function loadLandForBundle(neighborhoodDir: string) {
    const path = join(neighborhoodDir, 'land', 'evaluation.json');
    if (!existsSync(path)) return null;
    const file = JSON.parse(readFileSync(path, 'utf8')) as LandEvaluationFile;
    return {
        calibrated: false,
        method: file.method,
        generatedAt: file.generatedAt,
        rules: file.rules,
        crops: file.crops,
        cropRules: file.cropRules,
        sources: file.sources,
        stations: file.stations,
        district: file.district,
        neighbourhood: file.neighbourhood,
        summary: file.summary,
        parcels: file.parcels,
    };
}
