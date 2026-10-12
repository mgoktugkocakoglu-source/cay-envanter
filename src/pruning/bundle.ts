import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureCollection, Geometry } from 'geojson';
import { REQUIRED_FRACTION, pruningStatus, type PruningStatus } from './compliance.ts';
import { MIN_SCENE_TEA_MEDIAN } from '../ee/pruning.ts';
import type { NdviSeries } from '../ee/ndvi-series.ts';

/** Per parcel and season, as written by detect-pruning. */
interface SeasonParcel {
    key: string;
    teaAreaM2: number;
    observedTeaAreaM2: number;
    requiredM2: number;
    winterPrunedM2: number;
    springPrunedM2: number;
    prunedM2: number;
    vhChangeDb: number | null;
    status: PruningStatus;
}

interface SeasonFile {
    season: string;
    windows: { reference: [string, string]; winter: [string, string]; spring: [string, string] };
    stats: Record<string, number | null>;
    teaAreaM2: number;
    observedShare: number;
    winterPrunedM2: number;
    springPrunedM2: number;
    prunedM2: number;
    prunedShareOfTea: number;
    statusCounts: Record<PruningStatus, number>;
    parcels: SeasonParcel[];
}

export interface ParcelPruning {
    seasons: Record<string, Omit<SeasonParcel, 'key'>>;
    /** NDVI of the parcel's tea pixels on each series date (null = not observed). */
    ndvi: Array<number | null>;
}

/**
 * The pruning block of the site bundle: season summaries + pruned patches for the map,
 * the shared date axis and neighbourhood median for the curves, and per-parcel results.
 * `calibrated: false` until field-labelled seasons set the drop threshold.
 */
export function loadPruningForBundle(neighborhoodDir: string, roundCoords: (g: Geometry) => Geometry) {
    const dir = join(neighborhoodDir, 'pruning');
    if (!existsSync(dir)) {
        return { area: null, parcels: new Map<string, ParcelPruning>() };
    }
    const read = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
    const seasonFiles = readdirSync(dir)
        .filter((name) => /^season-.+\.json$/.test(name))
        .map((name) => read<SeasonFile>(name))
        .sort((a, b) => a.season.localeCompare(b.season));
    const series = existsSync(join(dir, 'ndvi-series.json')) ? read<NdviSeries>('ndvi-series.json') : null;

    const parcels = new Map<string, ParcelPruning>();
    for (const season of seasonFiles) {
        for (const { key, ...rest } of season.parcels) {
            const entry = parcels.get(key) ?? { seasons: {}, ndvi: series?.parcels[key] ?? [] };
            // Status re-derived from the stored areas, so a rule change does not need a new Earth Engine run.
            entry.seasons[season.season] = { ...rest, status: pruningStatus(rest) };
            parcels.set(key, entry);
        }
    }

    const area = {
        calibrated: false,
        method: 'Sentinel-2, aynı budama sezonu içinde referans (Eki–Kas), kış (Ara–Oca) ve bahar (Mar–Nis) dönemlerinin karşılaştırılması',
        requiredFraction: REQUIRED_FRACTION,
        minSceneTeaMedian: MIN_SCENE_TEA_MEDIAN,
        seasons: seasonFiles.map(({ parcels: rows, ...season }) => {
            const patchPath = join(dir, `pruned-patches-${season.season}.geojson`);
            const patches = existsSync(patchPath)
                ? JSON.parse(readFileSync(patchPath, 'utf8')) as FeatureCollection<Geometry, { areaM2: number }>
                : { features: [] };
            const statusCounts = Object.fromEntries(
                (['pruned', 'partial', 'no_trace', 'insufficient_observation', 'too_small'] as PruningStatus[])
                    .map((s) => [s, rows.filter((row) => pruningStatus(row) === s).length]),
            );
            return {
                ...season,
                statusCounts,
                patches: patches.features.map((f) => ({ areaM2: Math.round(f.properties.areaM2), geometry: roundCoords(f.geometry) })),
            };
        }),
        series: series
            ? { dates: series.dates, neighborhoodMedian: series.neighborhoodMedian, validTeaShare: series.validTeaShare }
            : null,
    };
    return { area, parcels };
}
