import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Geometry, MultiPolygon, Polygon } from 'geojson';
import {
    AUTO_APPROVAL,
    BOUNDARY_MATERIAL_SHARE,
    CYCLE_SEASONS,
    EXPERT_REVIEW_RATIO,
    PARTIAL_RATIO,
    REPEAT_REVIEW,
    REQUIRED_FRACTION,
    type ProducerStatus,
} from './compliance.ts';
import { buildDemoProducers } from './demo-producers.ts';
import { evaluateProducerSeason, type GardenSeries } from './evaluate.ts';
import { currentGeometry, producerLicensedAreaM2, type LicensingRegistry } from '../licensing/registry.ts';

type Poly = Polygon | MultiPolygon;

interface SeasonScanFile {
    season: string;
    every: number;
    lookbackDays: number;
    reference: [string, string];
    previousSeasons: string[];
    scanDates: string[];
    newObservation: boolean[];
    sceneDates: string[][];
    producers: Array<{
        id: string;
        name: string;
        walletNo: string;
        licenseNo: string;
        licensedAreaM2: number;
        teaAreaM2: number;
        requiredM2: number;
        grossPrunedM2: number;
        reusedM2: number;
        newPrunedM2: number;
        unattributedM2: number;
        unobservedM2: number;
        remainingM2: number;
        unresolvedGardens: number;
        status: ProducerStatus;
        autoApprovedAt: string | null;
        scans: Array<{ date: string; grossPrunedM2: number; newPrunedM2: number; observedShare: number; ratio: number; status: ProducerStatus }>;
    }>;
    gardens: Array<{
        id: string;
        teaAreaM2: number;
        observedM2: number[];
        prunedM2: number[];
        reusedM2: number[];
        eventAreaM2: number;
        eventReusedM2: number;
        lastNoChangeAt: string | null;
        firstChangeAt: string | null;
        detectedAt: string | null;
    }>;
    events: Array<{
        gardenId: string;
        areaM2: number;
        reusedM2: number;
        lastNoChangeAt: string | null;
        firstChangeAt: string | null;
        detectedAt: string | null;
        geometry: Poly;
    }>;
}

interface ScenesIndex {
    bounds: { west: number; south: number; east: number; north: number };
    seasons: Record<string, Array<{ date: string; file: string; teaVisible: number; teaMedianNdvi: number }>>;
}

/**
 * The producers block of the site bundle (v4): the demo register (producers + gardens, gardens
 * carrying their boundary status), every scanned season with per-producer results, per-garden
 * series and dated event polygons, and the per-scene imagery timeline.
 */
export function loadProducersForBundle(
    neighborhoodDir: string,
    parcels: Array<{ key: string; block: string; parcel: string; teaAreaM2: number | null; geometry: Poly }>,
    roundCoords: (g: Geometry) => Geometry,
    imageryBaseUrl: string,
    registry: LicensingRegistry | null,
) {
    const dir = join(neighborhoodDir, 'producers');
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((n) => /^season-\d{4}-\d{2}\.json$/.test(n)).sort();
    if (files.length === 0) return null;
    const seasons = files.map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as SeasonScanFile);

    // Same deterministic register the scans used, so garden ids line up.
    const { producers, gardens } = buildDemoProducers(parcels);
    const resolvedById = new Map(gardens.map((g) => [g.id, g.boundaryResolved]));

    // With a licence register, every season is re-judged offline on the register's licensed
    // areas (the satellite series never change; the licence side does).
    if (registry) {
        for (const s of seasons) {
            const seriesById = new Map<string, GardenSeries>(s.gardens.map((g) => [g.id, { ...g, boundaryResolved: resolvedById.get(g.id) ?? true }]));
            s.producers = producers.map((p) => ({
                ...p,
                ...evaluateProducerSeason(p.gardenIds, seriesById, s.scanDates, s.newObservation, producerLicensedAreaM2(registry, p.id)),
            }));
        }
    }
    const scenesPath = join(neighborhoodDir, 'pruning', 'imagery', 'scenes', 'index.json');
    const scenes = existsSync(scenesPath) ? (JSON.parse(readFileSync(scenesPath, 'utf8')) as ScenesIndex) : null;

    return {
        rules: {
            requiredFraction: REQUIRED_FRACTION,
            cycleSeasons: CYCLE_SEASONS,
            autoApproval: AUTO_APPROVAL,
            expertReviewRatio: EXPERT_REVIEW_RATIO,
            partialRatio: PARTIAL_RATIO,
            repeatReview: REPEAT_REVIEW,
            boundaryMaterialShare: BOUNDARY_MATERIAL_SHARE,
        },
        producers: producers.map((p) => ({
            code: p.id,
            name: p.name,
            walletNo: p.walletNo,
            // With a register, the producer's licence numbers come from it (empty: no licence).
            licenseNo: registry ? registry.licenses.filter((l) => l.producerCode === p.id).map((l) => l.code).join(', ') : p.licenseNo,
            gardenCodes: p.gardenIds,
        })),
        // With a register, the garden's map geometry is its licensed tea sub-polygon (current version).
        gardens: gardens.map((g) => {
            const licensed = registry?.gardens.find((x) => x.code === g.id);
            return {
                code: g.id,
                producerCode: g.producerId,
                parcelKey: g.parcelKey,
                block: g.block,
                parcel: g.parcel,
                holderIndex: g.holderIndex,
                holderCount: g.holderCount,
                boundaryResolved: g.boundaryResolved,
                geometryAreaM2: licensed ? licensed.planimetricAreaM2 : g.geometryAreaM2,
                geometry: roundCoords(licensed ? currentGeometry(licensed) : g.geometry),
            };
        }),
        seasons: seasons.map((s) => ({
            season: s.season,
            calibrated: false,
            demo: true,
            everyDays: s.every,
            lookbackDays: s.lookbackDays,
            reference: s.reference,
            previousSeasons: s.previousSeasons ?? [],
            scanDates: s.scanDates,
            newObservation: s.newObservation,
            sceneDates: s.sceneDates,
            producers: s.producers.map(({ id, name: _n, walletNo: _w, licenseNo: _l, ...rest }) => ({ code: id, ...rest })),
            gardens: s.gardens.map(({ id, ...rest }) => ({ code: id, ...rest })),
            events: s.events.map((e) => ({ ...e, gardenCode: e.gardenId, gardenId: undefined, geometry: roundCoords(e.geometry) })),
        })),
        scenes: scenes
            ? { baseUrl: `${imageryBaseUrl}scenes/`, bounds: scenes.bounds, seasons: scenes.seasons }
            : null,
    };
}
