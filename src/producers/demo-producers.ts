/**
 * DEMO producer (müstahsil) register on top of real TKGM parcels. ÇAYKUR's producer ↔ garden
 * data is not available yet, so this builds a deterministic, clearly fake register with the
 * structure the real one has:
 *  - one parcel can hold the gardens of 1–4 producers (shared titles: the parcel is split into
 *    sub-polygons, one per holder);
 *  - one producer can hold 1–6 gardens spread over different parcels.
 * Pruning is then judged per producer over all their gardens (the 1/7 rule applies to the
 * producer's licensed tea, not to a parcel).
 */
import { area, bbox, bboxClip, feature } from '@turf/turf';
import type { Feature, MultiPolygon, Polygon } from 'geojson';

export interface DemoGarden {
    id: string;
    producerId: string;
    parcelKey: string;
    block: string;
    parcel: string;
    /** 1-based holder index inside a shared parcel, and how many holders the parcel has. */
    holderIndex: number;
    holderCount: number;
    /**
     * False when the holder's slice inside a shared parcel is not surveyed yet: pruning there
     * cannot be attributed to this producer (BOUNDARY_UNRESOLVED). In the demo, one shared parcel
     * in five is left unresolved on purpose; the slice geometry is still kept for the map.
     */
    boundaryResolved: boolean;
    geometry: Polygon | MultiPolygon;
    geometryAreaM2: number;
}

export interface DemoProducer {
    id: string;
    name: string;
    walletNo: string;
    licenseNo: string;
    gardenIds: string[];
}

export interface TeaParcelInput {
    key: string;
    block: string;
    parcel: string;
    teaAreaM2: number | null;
    geometry: Polygon | MultiPolygon;
}

const FIRST = ['Mehmet', 'Ahmet', 'Mustafa', 'Hasan', 'Hüseyin', 'İsmail', 'Osman', 'Fatma', 'Ayşe', 'Emine', 'Hatice', 'Zeynep', 'Recep', 'Kadir', 'Yusuf', 'Halil', 'Murat', 'Elif', 'Sevda', 'Şükrü'];
const LAST = ['Demir', 'Yılmaz', 'Kara', 'Çelik', 'Şahin', 'Aydın', 'Öztürk', 'Kalkan', 'Topal', 'Bayraktar', 'Karadeniz', 'Uzun', 'Koç', 'Ermiş', 'Haliloğlu', 'Saral', 'Kırcı', 'Bekar', 'Gündüz', 'Tuna'];

/** A parcel needs at least this much tea to be a garden at all. */
const MIN_TEA_FOR_GARDEN_M2 = 150;
/** Each holder's slice keeps at least this much parcel area, so shared parcels stay plausible. */
const MIN_SLICE_M2 = 250;
/** Holders per tea parcel: 1 (55 %), 2 (25 %), 3 (12 %), 4 (8 %). */
const HOLDER_WEIGHTS: Array<[number, number]> = [[1, 0.55], [2, 0.25], [3, 0.12], [4, 0.08]];
/** Gardens per producer: 1 (30 %), 2 (25 %), 3 (20 %), 4 (12 %), 5 (8 %), 6 (5 %). */
const GARDEN_WEIGHTS: Array<[number, number]> = [[1, 0.3], [2, 0.25], [3, 0.2], [4, 0.12], [5, 0.08], [6, 0.05]];

function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function weighted(random: () => number, weights: Array<[number, number]>): number {
    let roll = random();
    for (const [value, weight] of weights) {
        roll -= weight;
        if (roll <= 0) return value;
    }
    return weights.at(-1)?.[0] ?? 1;
}

/**
 * Splits a parcel into `count` strips of equal area along its longer side (how inherited
 * gardens are usually divided on a slope). Cut positions are found by bisection on bboxClip.
 */
export function splitEqualStrips(geometry: Polygon | MultiPolygon, count: number): Array<Polygon | MultiPolygon> {
    const shape = feature(geometry);
    if (count <= 1) return [geometry];
    const [minX, minY, maxX, maxY] = bbox(shape);
    const alongX = maxX - minX >= maxY - minY;
    const total = area(shape);
    const clipTo = (cut: number) => bboxClip(shape, alongX ? [minX, minY, cut, maxY] : [minX, minY, maxX, cut]);
    const cuts: number[] = [];
    for (let i = 1; i < count; i++) {
        let lo = alongX ? minX : minY;
        let hi = alongX ? maxX : maxY;
        for (let step = 0; step < 40; step++) {
            const mid = (lo + hi) / 2;
            if (area(clipTo(mid)) < (total * i) / count) lo = mid;
            else hi = mid;
        }
        cuts.push((lo + hi) / 2);
    }
    const edges = [alongX ? minX : minY, ...cuts, alongX ? maxX : maxY];
    return edges.slice(0, -1).map((from, i) => {
        const to = edges[i + 1] as number;
        const piece = bboxClip(shape, alongX ? [from, minY, to, maxY] : [minX, from, maxX, to]);
        return piece.geometry as Polygon | MultiPolygon;
    });
}

export function buildDemoProducers(parcels: TeaParcelInput[], seed = 2026): { producers: DemoProducer[]; gardens: DemoGarden[] } {
    const random = mulberry32(seed);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)] as T;

    // 1. Gardens: every tea parcel split among 1–4 holders.
    const gardens: DemoGarden[] = [];
    for (const parcel of parcels.filter((p) => (p.teaAreaM2 ?? 0) >= MIN_TEA_FOR_GARDEN_M2)) {
        const parcelArea = area(feature(parcel.geometry));
        const maxHolders = Math.max(1, Math.min(4, Math.floor(parcelArea / MIN_SLICE_M2)));
        const holders = Math.min(weighted(random, HOLDER_WEIGHTS), maxHolders);
        const boundaryResolved = holders === 1 || random() >= 0.2;
        splitEqualStrips(parcel.geometry, holders).forEach((geometry, i) => {
            gardens.push({
                id: `DEMO-B-${String(gardens.length + 1).padStart(4, '0')}`,
                producerId: '',
                parcelKey: parcel.key,
                block: parcel.block,
                parcel: parcel.parcel,
                holderIndex: i + 1,
                holderCount: holders,
                boundaryResolved,
                geometry,
                geometryAreaM2: Math.round(area(feature(geometry))),
            });
        });
    }

    // 2. Producers: deal the gardens out, 1–6 each, never two gardens of the same parcel.
    const pool = [...gardens].sort(() => random() - 0.5);
    const producers: DemoProducer[] = [];
    while (pool.length > 0) {
        const wanted = weighted(random, GARDEN_WEIGHTS);
        const own: DemoGarden[] = [];
        for (let i = 0; i < pool.length && own.length < wanted; ) {
            const garden = pool[i] as DemoGarden;
            if (own.some((g) => g.parcelKey === garden.parcelKey)) {
                i++;
                continue;
            }
            own.push(garden);
            pool.splice(i, 1);
        }
        const serial = producers.length + 1;
        const id = `DEMO-M-${String(serial).padStart(4, '0')}`;
        for (const garden of own) garden.producerId = id;
        producers.push({
            id,
            name: `${pick(FIRST)} ${pick(LAST)}`,
            walletNo: `DEMO-C-${String(70_000 + serial)}`,
            licenseNo: `DEMO-R-${String(9_000 + serial)}`,
            gardenIds: own.map((g) => g.id),
        });
    }
    return { producers, gardens };
}
