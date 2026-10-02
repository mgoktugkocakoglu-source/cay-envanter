import type { AdminUnit, TkgmRawParcel } from './types.ts';

const BASE_URL = 'https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api';
const REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface TkgmClientOptions {
    /** Minimum gap between two requests. The public service is shared; keep this polite (>= 1000 ms). */
    minIntervalMs: number;
    maxRetries: number;
}

interface AdminFeatureCollection {
    features: Array<{
        geometry: AdminUnit['geometry'];
        properties: { id: string; text: string };
    }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Throttled client for the public TKGM MEGSİS web API.
 * Same endpoints as cayhesabim's GeoService, plus rate limiting, retry with backoff and 404 → null.
 */
export class TkgmClient {
    private readonly options: TkgmClientOptions;
    private lastRequestAt = 0;
    requestCount = 0;

    constructor(options: TkgmClientOptions) {
        this.options = options;
    }

    async listProvinces(): Promise<AdminUnit[]> {
        return this.getAdminList('maksIdariYapi/illiste');
    }

    async listDistricts(provinceId: string): Promise<AdminUnit[]> {
        return this.getAdminList(`maksIdariYapi/ilceliste/${provinceId}`);
    }

    async listNeighborhoods(districtId: string): Promise<AdminUnit[]> {
        return this.getAdminList(`maksIdariYapi/mahalleliste/${districtId}`);
    }

    /** Parcel containing the point, or null when TKGM has no parcel there (road, river, unsurveyed land). */
    async getParcelAt(lat: number, lng: number): Promise<TkgmRawParcel | null> {
        const parcel = await this.getJson<TkgmRawParcel>(`parsel/${lat.toFixed(7)}/${lng.toFixed(7)}/`);
        return parcel?.geometry ? parcel : null;
    }

    /** Parcel by number. `neighborhoodId` is TKGM's numeric `mahalleId`, not the admin-list GUID. */
    async getParcelByNumber(neighborhoodId: number, block: number, parcel: number): Promise<TkgmRawParcel | null> {
        const raw = await this.getJson<TkgmRawParcel>(`parsel/${neighborhoodId}/${block}/${parcel}`);
        return raw?.geometry ? raw : null;
    }

    private async getAdminList(path: string): Promise<AdminUnit[]> {
        const data = await this.getJson<AdminFeatureCollection>(path);
        return (data?.features ?? []).map((feature) => ({
            id: feature.properties.id,
            name: feature.properties.text,
            geometry: feature.geometry,
        }));
    }

    private async getJson<T>(path: string): Promise<T | null> {
        for (let attempt = 0; ; attempt++) {
            await this.throttle();
            this.requestCount++;
            try {
                const response = await fetch(`${BASE_URL}/${path}`, {
                    headers: { Accept: 'application/json' },
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
                if (response.status === 404) {
                    return null;
                }
                if (response.ok) {
                    return (await response.json()) as T;
                }
                if (!RETRYABLE_STATUS.has(response.status) || attempt >= this.options.maxRetries) {
                    throw new Error(`TKGM ${response.status} for ${path}`);
                }
            } catch (error) {
                const isNetworkError = error instanceof TypeError || (error as Error).name === 'TimeoutError';
                if (!isNetworkError || attempt >= this.options.maxRetries) {
                    throw error;
                }
            }
            await sleep(5_000 * 2 ** attempt);
        }
    }

    private async throttle(): Promise<void> {
        const jitter = Math.random() * 250;
        const wait = this.lastRequestAt + this.options.minIntervalMs + jitter - Date.now();
        if (wait > 0) {
            await sleep(wait);
        }
        this.lastRequestAt = Date.now();
    }
}
