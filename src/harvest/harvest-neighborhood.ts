import { pointOnFeature, feature } from '@turf/turf';
import type { Position } from 'geojson';
import { CoverageTracker, type CoverageOptions } from './coverage.ts';
import { normalizeParcel, parcelKey } from '../tkgm/normalize.ts';
import { TkgmQuotaExceededError, type TkgmClient } from '../tkgm/client.ts';
import type { Parcel, TkgmRawParcel } from '../tkgm/types.ts';
import type { NeighborhoodMeta, NeighborhoodStore } from '../library/store.ts';

/**
 * Gap filling runs only where the block scan left holes, which are mostly roads and streams:
 * corridors narrower than 2×erode are skipped and a miss clears a wider disc.
 */
const COVERAGE: CoverageOptions = { erodeMeters: 4, missRadiusMeters: 15, probeRadiusMeters: 1.5 };
/** Cadastre renewals usually number blocks from 101; block 0 holds old pafta-only parcels. */
const FIRST_BLOCK = 101;
/** Consecutive missing parcel numbers before a block is considered finished. */
const MAX_PARCEL_GAP = 3;
/** Consecutive empty blocks before the block scan stops in that direction. */
const MAX_EMPTY_BLOCKS = 8;
const PROGRESS_EVERY = 50;

export interface HarvestOptions {
    maxRequests: number;
}

export type HarvestOutcome = 'complete' | 'request_limit' | 'daily_quota';

export interface HarvestResult {
    outcome: HarvestOutcome;
    neighborhoodId: number | null;
    parcels: Parcel[];
    queries: number;
    misses: number;
    coveredRatio: number;
    droppedSliverM2: number;
}

class RequestLimitReached extends Error {}

/**
 * Enumerates every TKGM parcel of a neighborhood in two passes:
 *  1. block scan — query neighborhoodId/block/parcel numbers in sequence (nearly every request hits);
 *  2. gap fill  — probe by coordinate wherever the boundary is still uncovered; a parcel found there
 *     in an unscanned block triggers a block scan of that block.
 * Every query is appended to disk, so an interrupted run resumes without repeating requests.
 */
class NeighborhoodHarvest {
    private readonly client: TkgmClient;
    private readonly meta: NeighborhoodMeta;
    private readonly store: NeighborhoodStore;
    private readonly requestBudgetEnd: number;
    private readonly tracker: CoverageTracker;
    private readonly known = new Map<string, Parcel>();
    private readonly missedKeys = new Set<string>();
    private readonly scannedBlocks = new Set<number>();
    private neighborhoodId: number | null = null;
    private queries = 0;
    private misses = 0;

    constructor(client: TkgmClient, meta: NeighborhoodMeta, store: NeighborhoodStore, options: HarvestOptions) {
        this.client = client;
        this.meta = meta;
        this.store = store;
        this.requestBudgetEnd = client.requestCount + options.maxRequests;
        this.tracker = new CoverageTracker(meta.boundary, COVERAGE);
    }

    async run(): Promise<HarvestResult> {
        this.resume();
        let outcome: HarvestOutcome = 'complete';
        try {
            this.neighborhoodId ??= await this.discoverNeighborhoodId();
            if (this.neighborhoodId !== null) {
                await this.scanBlocks(this.neighborhoodId);
            }
            await this.fillGaps();
        } catch (error) {
            if (error instanceof RequestLimitReached) {
                outcome = 'request_limit';
            } else if (error instanceof TkgmQuotaExceededError) {
                outcome = 'daily_quota';
            } else {
                throw error;
            }
        }
        return {
            outcome,
            neighborhoodId: this.neighborhoodId,
            parcels: [...this.known.values()],
            queries: this.queries,
            misses: this.misses,
            coveredRatio: this.tracker.coveredRatio,
            droppedSliverM2: this.tracker.droppedSliverM2,
        };
    }

    private resume(): void {
        for (const parcel of this.store.loadParcels()) {
            this.known.set(parcel.properties.key, parcel);
            if (parcel.properties.inTargetNeighborhood) {
                this.neighborhoodId ??= parcel.properties.neighborhoodId;
            }
        }
        const probes = this.store.loadProbes();
        for (const probe of probes) {
            this.queries++;
            if (probe.result === 'miss') {
                this.misses++;
                if (probe.kind === 'number' && probe.key) {
                    this.missedKeys.add(probe.key);
                }
            }
        }
        this.tracker.markParcels([...this.known.values()].map((parcel) => parcel.geometry));
        this.tracker.markProbes(
            probes
                .filter((p) => p.kind === 'point' && p.lng !== undefined && p.lat !== undefined)
                .map((p) => ({ position: [p.lng!, p.lat!], hit: p.result !== 'miss' })),
        );
        if (probes.length > 0) {
            this.log('resumed');
        }
    }

    /** The admin list only has a GUID; the numeric mahalleId comes from any parcel inside the boundary. */
    private async discoverNeighborhoodId(): Promise<number | null> {
        for (let attempt = 0; attempt < 20; attempt++) {
            const probe = attempt === 0 ? pointOnFeature(feature(this.meta.boundary)).geometry.coordinates : this.tracker.nextProbe();
            if (!probe) {
                return null;
            }
            const parcel = await this.queryPoint(probe);
            if (parcel?.properties.inTargetNeighborhood) {
                return parcel.properties.neighborhoodId;
            }
        }
        return null;
    }

    private async scanBlocks(neighborhoodId: number): Promise<void> {
        const knownBlocks = [...this.known.values()]
            .filter((p) => p.properties.inTargetNeighborhood)
            .map((p) => Number(p.properties.block))
            .filter(Number.isInteger);
        const start = Math.min(FIRST_BLOCK, ...knownBlocks);
        await this.scanBlockRange(neighborhoodId, start, 1);
        await this.scanBlockRange(neighborhoodId, start - 1, -1);
        await this.scanBlock(neighborhoodId, 0, 1);
    }

    private async scanBlockRange(neighborhoodId: number, from: number, step: 1 | -1): Promise<void> {
        let emptyRun = 0;
        for (let block = from; block >= 1 && emptyRun < MAX_EMPTY_BLOCKS; block += step) {
            const found = await this.scanBlock(neighborhoodId, block, 1);
            emptyRun = found > 0 ? 0 : emptyRun + 1;
        }
    }

    /** Walks parcel numbers upward from `fromParcel` until MAX_PARCEL_GAP consecutive misses. */
    private async scanBlock(neighborhoodId: number, block: number, fromParcel: number): Promise<number> {
        this.scannedBlocks.add(block);
        let found = 0;
        let gap = 0;
        for (let parcelNo = fromParcel; gap < MAX_PARCEL_GAP; parcelNo++) {
            const key = parcelKey(neighborhoodId, String(block), String(parcelNo));
            if (this.known.has(key)) {
                found++;
                gap = 0;
                continue;
            }
            if (this.missedKeys.has(key)) {
                gap++;
                continue;
            }
            this.ensureBudget();
            const raw = await this.client.getParcelByNumber(neighborhoodId, block, parcelNo);
            this.queries++;
            if (raw) {
                this.record(raw, 'number', key);
                found++;
                gap = 0;
            } else {
                this.misses++;
                this.missedKeys.add(key);
                this.store.appendNumberProbe(key, 'miss');
                gap++;
            }
            this.maybeLog();
        }
        return found;
    }

    private async fillGaps(): Promise<void> {
        for (let probe = this.tracker.nextProbe(); probe; probe = this.tracker.nextProbe()) {
            const parcel = await this.queryPoint(probe);
            const block = Number(parcel?.properties.block);
            if (
                parcel?.properties.inTargetNeighborhood &&
                this.neighborhoodId !== null &&
                Number.isInteger(block) &&
                !this.scannedBlocks.has(block)
            ) {
                await this.scanBlock(this.neighborhoodId, block, 1);
            } else if (parcel?.properties.inTargetNeighborhood && this.neighborhoodId !== null && Number.isInteger(block)) {
                // Block was scanned but this parcel sat beyond a numbering gap: continue past it.
                await this.scanBlock(this.neighborhoodId, block, Number(parcel.properties.parcel) + 1);
            }
        }
    }

    private async queryPoint(probe: Position): Promise<Parcel | null> {
        this.ensureBudget();
        const raw = await this.client.getParcelAt(probe[1], probe[0]);
        this.queries++;
        this.maybeLog();
        if (!raw) {
            this.misses++;
            this.store.appendPointProbe(probe, 'miss', null);
            this.tracker.markProbes([{ position: probe, hit: false }]);
            return null;
        }
        const parcel = this.record(raw, 'point', null, probe);
        this.tracker.markProbes([{ position: probe, hit: true }]);
        return parcel;
    }

    private record(raw: TkgmRawParcel, kind: 'point' | 'number', queriedKey: string | null, probe?: Position): Parcel {
        const parcel = normalizeParcel(raw, this.meta.neighborhood);
        const key = parcel.properties.key;
        const isDuplicate = this.known.has(key);
        if (!isDuplicate) {
            this.known.set(key, parcel);
            this.store.appendParcel(parcel);
            this.tracker.markParcels([parcel.geometry]);
        }
        const result = isDuplicate ? 'duplicate' : 'parcel';
        if (kind === 'point' && probe) {
            this.store.appendPointProbe(probe, result, key);
        } else {
            this.store.appendNumberProbe(queriedKey ?? key, result);
        }
        return this.known.get(key)!;
    }

    private ensureBudget(): void {
        if (this.client.requestCount >= this.requestBudgetEnd) {
            throw new RequestLimitReached();
        }
    }

    private maybeLog(): void {
        if (this.queries % PROGRESS_EVERY === 0) {
            this.log('progress');
        }
    }

    private log(label: string): void {
        console.log(
            `  ${label}: queries ${this.queries} | parcels ${this.known.size} | misses ${this.misses} | ` +
                `blocks ${this.scannedBlocks.size} | covered ${(this.tracker.coveredRatio * 100).toFixed(1)}%`,
        );
    }
}

export function harvestNeighborhood(
    client: TkgmClient,
    meta: NeighborhoodMeta,
    store: NeighborhoodStore,
    options: HarvestOptions,
): Promise<HarvestResult> {
    return new NeighborhoodHarvest(client, meta, store, options).run();
}
