import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Polygon, MultiPolygon, Position } from 'geojson';
import type { Parcel } from '../tkgm/types.ts';

export const LIBRARY_ROOT = join(process.cwd(), 'data', 'library');

export type ProbeResult = 'parcel' | 'duplicate' | 'miss';

/**
 * One TKGM query. `point` probes carry the coordinate; `number` probes carry the queried
 * neighborhoodId/block/parcel key (also on a miss, so a resumed run does not repeat it).
 */
export interface ProbeRecord {
    kind: 'point' | 'number';
    lng?: number;
    lat?: number;
    result: ProbeResult;
    key: string | null;
    at: string;
}

export interface NeighborhoodMeta {
    province: string;
    district: string;
    neighborhood: string;
    neighborhoodGuid: string;
    boundary: Polygon | MultiPolygon;
}

/** "Çataldere Mah." → "cataldere" */
export function slugify(name: string): string {
    const map: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', i: 'i', ö: 'o', ş: 's', ü: 'u' };
    return name
        .replace(/\s+(mah\.?|mahallesi|köyü)$/i, '')
        .toLocaleLowerCase('tr')
        .replace(/[çğıiöşü]/g, (ch) => map[ch] ?? ch)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

function readNdjson<T>(path: string): T[] {
    if (!existsSync(path)) {
        return [];
    }
    return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as T);
}

/**
 * One neighborhood inside a district library:
 *   data/library/<province>/<district>/<neighborhood>/
 *     meta.json        boundary + names
 *     parcels.ndjson   one normalized parcel per line (append-only, resumable)
 *     probes.ndjson    every query point and its outcome (audit trail + resume)
 */
export class NeighborhoodStore {
    readonly dir: string;
    private readonly parcelsPath: string;
    private readonly probesPath: string;

    constructor(province: string, district: string, neighborhood: string) {
        this.dir = join(LIBRARY_ROOT, slugify(province), slugify(district), slugify(neighborhood));
        this.parcelsPath = join(this.dir, 'parcels.ndjson');
        this.probesPath = join(this.dir, 'probes.ndjson');
        mkdirSync(this.dir, { recursive: true });
    }

    writeMeta(meta: NeighborhoodMeta): void {
        writeFileSync(join(this.dir, 'meta.json'), JSON.stringify(meta, null, 2));
    }

    readMeta(): NeighborhoodMeta | null {
        const path = join(this.dir, 'meta.json');
        return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as NeighborhoodMeta) : null;
    }

    loadParcels(): Parcel[] {
        return readNdjson<Parcel>(this.parcelsPath);
    }

    loadProbes(): ProbeRecord[] {
        return readNdjson<ProbeRecord>(this.probesPath);
    }

    appendParcel(parcel: Parcel): void {
        appendFileSync(this.parcelsPath, JSON.stringify(parcel) + '\n');
    }

    appendPointProbe(probe: Position, result: ProbeResult, key: string | null): void {
        this.appendProbe({ kind: 'point', lng: probe[0], lat: probe[1], result, key, at: new Date().toISOString() });
    }

    appendNumberProbe(key: string, result: ProbeResult): void {
        this.appendProbe({ kind: 'number', result, key, at: new Date().toISOString() });
    }

    private appendProbe(record: ProbeRecord): void {
        appendFileSync(this.probesPath, JSON.stringify(record) + '\n');
    }

    writeSummary(summary: object): void {
        writeFileSync(join(this.dir, 'summary.json'), JSON.stringify(summary, null, 2));
    }

    writeGeoJson(name: string, parcels: Parcel[]): void {
        writeFileSync(join(this.dir, name), JSON.stringify({ type: 'FeatureCollection', features: parcels }));
    }
}
