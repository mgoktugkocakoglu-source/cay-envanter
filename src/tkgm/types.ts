import type { Feature, Polygon, MultiPolygon } from 'geojson';

/** Raw parcel properties as returned by TKGM `parsel/{lat}/{lng}` (Turkish keys, string numbers). */
export interface TkgmRawParcelProperties {
    ilAd: string;
    ilceAd: string;
    mahalleAd: string;
    ilId: number;
    ilceId: number;
    mahalleId: number;
    adaNo: string;
    parselNo: string;
    alan: string;
    nitelik: string;
    mevkii: string;
    pafta: string;
    ozet: string;
    durum: string;
    zeminKmdurum: string;
    gittigiParselListe: string;
    gittigiParselSebep: string;
}

export type TkgmRawParcel = Feature<Polygon | MultiPolygon, TkgmRawParcelProperties>;

/** Province / district / neighborhood entry from the `maksIdariYapi` lists. */
export interface AdminUnit {
    id: string;
    name: string;
    geometry: Polygon | MultiPolygon;
}

/** Normalized parcel record stored in the library (English keys, numeric areas). */
export interface ParcelProperties {
    key: string;
    province: string;
    district: string;
    neighborhood: string;
    provinceId: number;
    districtId: number;
    neighborhoodId: number;
    block: string;
    parcel: string;
    /** TKGM "nitelik" (land use title on the deed), e.g. "Çay Bahçesi", "Tarla", "Fındık Bahçesi". */
    nature: string;
    /** Deed area from TKGM, parsed from Turkish number format ("59.955,71" → 59955.71). */
    deedAreaM2: number | null;
    /** Geodesic horizontal area of the returned polygon (for cross-checking the deed area). */
    geometryAreaM2: number;
    locality: string;
    sheet: string;
    summary: string;
    status: string;
    landStatus: string;
    /** Parcels this one was split/merged into ("gittigiParselListe") — key to the old→new parcel problem. */
    successorParcels: string;
    successorReason: string;
    /** False when the parcel belongs to a neighboring mahalle (the admin boundary is generalized). */
    inTargetNeighborhood: boolean;
    fetchedAt: string;
}

export type Parcel = Feature<Polygon | MultiPolygon, ParcelProperties>;
