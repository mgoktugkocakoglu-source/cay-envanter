import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Geometry, MultiPolygon, Polygon } from 'geojson';
import { AUTO_APPROVAL, EXPERT_REVIEW_RATIO, PARTIAL_RATIO, REQUIRED_FRACTION, type ProducerStatus } from './compliance.ts';

interface SeasonScanFile {
    season: string;
    every: number;
    lookbackDays: number;
    reference: [string, string];
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
        prunedM2: number;
        status: ProducerStatus;
        autoApprovedAt: string | null;
        scans: Array<{ date: string; prunedM2: number; observedShare: number; ratio: number; status: ProducerStatus }>;
    }>;
    gardens: Array<{
        id: string;
        producerId: string;
        parcelKey: string;
        block: string;
        parcel: string;
        holderIndex: number;
        holderCount: number;
        geometry: Polygon | MultiPolygon;
        geometryAreaM2: number;
        teaAreaM2: number;
        prunedM2: number[];
    }>;
}

/**
 * The producers block of the site bundle (v3): the latest scanned season's schedule, every
 * producer with their scan history, and every garden with its geometry and pruned series.
 */
export function loadProducersForBundle(neighborhoodDir: string, roundCoords: (g: Geometry) => Geometry) {
    const dir = join(neighborhoodDir, 'producers');
    if (!existsSync(dir)) return null;
    const latest = readdirSync(dir).filter((n) => /^season-.+\.json$/.test(n)).sort().at(-1);
    if (!latest) return null;
    const file = JSON.parse(readFileSync(join(dir, latest), 'utf8')) as SeasonScanFile;
    return {
        schedule: {
            season: file.season,
            calibrated: false,
            demo: true,
            everyDays: file.every,
            lookbackDays: file.lookbackDays,
            reference: file.reference,
            scanDates: file.scanDates,
            newObservation: file.newObservation,
            sceneDates: file.sceneDates,
            rules: {
                requiredFraction: REQUIRED_FRACTION,
                autoApproval: AUTO_APPROVAL,
                expertReviewRatio: EXPERT_REVIEW_RATIO,
                partialRatio: PARTIAL_RATIO,
            },
        },
        producers: file.producers.map((p) => ({
            code: p.id,
            name: p.name,
            walletNo: p.walletNo,
            licenseNo: p.licenseNo,
            licensedAreaM2: p.licensedAreaM2,
            teaAreaM2: p.teaAreaM2,
            requiredM2: p.requiredM2,
            prunedM2: p.prunedM2,
            status: p.status,
            autoApprovedAt: p.autoApprovedAt,
            scans: p.scans,
        })),
        gardens: file.gardens.map((g) => ({
            code: g.id,
            producerCode: g.producerId,
            parcelKey: g.parcelKey,
            block: g.block,
            parcel: g.parcel,
            holderIndex: g.holderIndex,
            holderCount: g.holderCount,
            geometryAreaM2: g.geometryAreaM2,
            teaAreaM2: g.teaAreaM2,
            prunedSeries: g.prunedM2,
            geometry: roundCoords(g.geometry),
        })),
    };
}
