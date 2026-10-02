import { area, buffer, circle, difference, featureCollection, feature, flatten, pointOnFeature } from '@turf/turf';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';

type Area = Feature<Polygon | MultiPolygon>;

export interface CoverageOptions {
    /**
     * Uncovered pieces narrower than ~2× this (in meters) are not probed: they are the slivers left by
     * TKGM's 5-decimal (~1 m) coordinate rounding, or road/stream corridors that carry no parcel.
     */
    erodeMeters: number;
    /** Radius marked as covered around a probe that returned no parcel. */
    missRadiusMeters: number;
    /** Radius always marked as covered around any probe, guaranteeing progress. */
    probeRadiusMeters: number;
}

/**
 * Tracks the part of a neighborhood boundary not yet explained by a fetched parcel or a known gap,
 * and proposes the next point to query. The public TKGM API has no "list all parcels" call, so a
 * neighborhood is enumerated by repeatedly probing the uncovered remainder.
 */
export class CoverageTracker {
    private readonly options: CoverageOptions;
    private readonly boundaryAreaM2: number;
    private remainder: Area | null;
    droppedSliverM2 = 0;

    constructor(boundary: Polygon | MultiPolygon, options: CoverageOptions) {
        this.options = options;
        this.remainder = feature(boundary);
        this.boundaryAreaM2 = area(this.remainder);
    }

    get boundaryArea(): number {
        return this.boundaryAreaM2;
    }

    get uncoveredAreaM2(): number {
        return this.remainder ? area(this.remainder) : 0;
    }

    get coveredRatio(): number {
        return 1 - this.uncoveredAreaM2 / this.boundaryAreaM2;
    }

    /** Marks parcels as covered in one clipping pass (used both per probe and when resuming). */
    markParcels(geometries: Array<Polygon | MultiPolygon>): void {
        this.subtract(...geometries.map((geometry) => feature(geometry)));
    }

    /** Marks the probe neighborhood as covered: a small disc on a hit, a wider one on a miss. */
    markProbes(probes: Array<{ position: Position; hit: boolean }>): void {
        this.subtract(
            ...probes.map(({ position, hit }) =>
                circle(position, hit ? this.options.probeRadiusMeters : this.options.missRadiusMeters, {
                    units: 'meters',
                    steps: 16,
                }),
            ),
        );
    }

    /** Next [lng, lat] to query, or null when every remaining piece is a sliver. */
    nextProbe(): Position | null {
        if (!this.remainder) {
            return null;
        }
        const pieces = flatten(this.remainder).features
            .map((piece) => ({ piece, areaM2: area(piece) }))
            .sort((a, b) => b.areaM2 - a.areaM2);
        const slivers: Area[] = [];
        let probe: Position | null = null;
        for (const { piece, areaM2 } of pieces) {
            const eroded = buffer(piece, -this.options.erodeMeters, { units: 'meters' });
            if (eroded?.geometry && area(eroded) > 0) {
                probe = pointOnFeature(eroded).geometry.coordinates;
                break;
            }
            slivers.push(piece);
            this.droppedSliverM2 += areaM2;
        }
        this.subtract(...slivers);
        return probe;
    }

    private subtract(...pieces: Area[]): void {
        if (!this.remainder || pieces.length === 0) {
            return;
        }
        this.remainder = difference(featureCollection([this.remainder, ...pieces]));
    }
}
