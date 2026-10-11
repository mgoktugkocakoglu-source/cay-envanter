import { createHash } from 'node:crypto';
import { buffer } from '@turf/turf';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import type { Parcel } from '../tkgm/types.ts';

/**
 * Weak labels from the TKGM deed title ("nitelik"). Only single-use titles are trusted; mixed
 * titles such as "2 Katlı Kargir Ev Ve Çay Bahçesi" are predicted but never trained on.
 * These labels are noisy by nature (the title can be decades old) — a pilot stand-in for
 * field-verified samples, which should replace them before any operational use.
 */
const TEA_TITLE = /^çay bahçesi\.?$/i;
const NON_TEA_TITLES = /^(orman|fındık bahçesi|fındıklık|çayır|tarla|mera)\.?$/i;
/** Inner buffer so mixed edge pixels (roads, neighbors) do not leak into training. */
const INNER_BUFFER_M = 3;
const TEST_SHARE = 0.25;

export type TeaLabel = 0 | 1;

export interface LabelledParcel {
    parcel: Parcel;
    label: TeaLabel | null;
    split: 'train' | 'test' | null;
    trainingGeometry: Polygon | MultiPolygon | null;
}

export function weakLabel(nature: string): TeaLabel | null {
    const title = nature.trim().toLocaleLowerCase('tr');
    if (TEA_TITLE.test(title)) {
        return 1;
    }
    return NON_TEA_TITLES.test(title) ? 0 : null;
}

/** Deterministic parcel-level split: whole parcels go to train or test, never pixels of both. */
function splitOf(key: string): 'train' | 'test' {
    const bucket = createHash('sha1').update(key).digest().readUInt16BE(0) / 0xffff;
    return bucket < TEST_SHARE ? 'test' : 'train';
}

export function labelParcels(parcels: Parcel[]): LabelledParcel[] {
    return parcels.map((parcel) => {
        const label = weakLabel(parcel.properties.nature);
        if (label === null) {
            return { parcel, label, split: null, trainingGeometry: null };
        }
        const inner = buffer(parcel as Feature<Polygon | MultiPolygon>, -INNER_BUFFER_M, { units: 'meters' });
        return {
            parcel,
            label,
            split: splitOf(parcel.properties.key),
            trainingGeometry: inner?.geometry ?? parcel.geometry,
        };
    });
}
