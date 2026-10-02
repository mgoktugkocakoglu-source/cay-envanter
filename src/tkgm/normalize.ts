import { area } from '@turf/turf';
import type { Parcel, TkgmRawParcel } from './types.ts';

/** "59.955,71" → 59955.71 ; "731,07" → 731.07 ; "" → null. */
export function parseTurkishNumber(value: string | undefined): number | null {
    const cleaned = (value ?? '').trim().replace(/\./g, '').replace(',', '.');
    if (cleaned === '') {
        return null;
    }
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
}

export function parcelKey(neighborhoodId: number, block: string, parcel: string): string {
    return `${neighborhoodId}/${block.trim()}/${parcel.trim()}`;
}

/** "Çataldere Mah." and "Çataldere" compare equal (admin lists add a suffix, parcel records do not). */
export function sameNeighborhoodName(a: string, b: string): boolean {
    const clean = (name: string) => name.replace(/\s+(mah\.?|mahallesi|köyü)$/i, '').trim().toLocaleLowerCase('tr');
    return clean(a) === clean(b);
}

export function normalizeParcel(raw: TkgmRawParcel, targetNeighborhoodName: string): Parcel {
    const p = raw.properties;
    const neighborhoodId = Number(p.mahalleId);
    return {
        type: 'Feature',
        geometry: raw.geometry,
        properties: {
            key: parcelKey(neighborhoodId, p.adaNo ?? '', p.parselNo ?? ''),
            province: p.ilAd ?? '',
            district: p.ilceAd ?? '',
            neighborhood: p.mahalleAd ?? '',
            provinceId: Number(p.ilId),
            districtId: Number(p.ilceId),
            neighborhoodId,
            block: (p.adaNo ?? '').trim(),
            parcel: (p.parselNo ?? '').trim(),
            nature: (p.nitelik ?? '').trim(),
            deedAreaM2: parseTurkishNumber(p.alan),
            geometryAreaM2: Math.round(area(raw) * 100) / 100,
            locality: (p.mevkii ?? '').trim(),
            sheet: (p.pafta ?? '').trim(),
            summary: (p.ozet ?? '').trim(),
            status: String(p.durum ?? ''),
            landStatus: (p.zeminKmdurum ?? '').trim(),
            successorParcels: (p.gittigiParselListe ?? '').trim(),
            successorReason: (p.gittigiParselSebep ?? '').trim(),
            inTargetNeighborhood: sameNeighborhoodName(p.mahalleAd ?? '', targetNeighborhoodName),
            fetchedAt: new Date().toISOString(),
        },
    };
}
