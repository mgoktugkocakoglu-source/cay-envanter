import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ee from '@google/earthengine';

const KEY_PATH = process.env.EE_KEY_PATH ?? join(process.cwd(), 'secrets', 'ee-key.json');

interface ServiceAccountKey {
    project_id: string;
    client_email: string;
    private_key: string;
}

/** Authenticates the Earth Engine client with the service-account key in secrets/ (never committed). */
export async function initEarthEngine(): Promise<typeof ee> {
    const key = JSON.parse(readFileSync(KEY_PATH, 'utf8')) as ServiceAccountKey;
    await new Promise<void>((resolve, reject) =>
        ee.data.authenticateViaPrivateKey(key, () => resolve(), (error: unknown) => reject(new Error(String(error)))),
    );
    await new Promise<void>((resolve, reject) =>
        ee.initialize(null, null, () => resolve(), (error: unknown) => reject(new Error(String(error))), null, key.project_id),
    );
    return ee;
}

/** Promise wrapper for ee.ComputedObject.evaluate. */
export function evaluate<T>(object: { evaluate: (callback: (value: T, error?: string) => void) => void }): Promise<T> {
    return new Promise((resolve, reject) =>
        object.evaluate((value, error) => (error ? reject(new Error(error)) : resolve(value))),
    );
}

/** Errors Earth Engine raises when one request is too big for a worker; the caller then splits the request. */
export function isCapacityError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /memory capacity exceeded|user memory limit|too many pixels|too large|timed out|computation timed out/i.test(message);
}

/**
 * Reduces one image per date over a feature collection (mean), in chunks of dates. A chunk that
 * exceeds Earth Engine's memory or time limit is split in two, down to a single date, which is
 * then retried with a larger tileScale — so a long season never fails as a whole.
 * Returns, per feature id, the band → value map with toBands' "<index>_" prefix removed.
 */
export async function reduceDatesInChunks(
    ee: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    dates: string[],
    imageFor: (date: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
    features: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    scale: number,
    datesPerChunk = 16,
    idProperty = 'id',
): Promise<Map<string, Record<string, number | null>>> {
    const out = new Map<string, Record<string, number | null>>();
    const run = async (chunk: string[], tileScale: number): Promise<void> => {
        const stack = ee.ImageCollection(ee.List(chunk).map((d: unknown) => imageFor(d))).toBands();
        let rows: { features: Array<{ properties: Record<string, number | string | null> }> };
        try {
            rows = await evaluate(stack.reduceRegions({ collection: features, reducer: ee.Reducer.mean(), scale, tileScale }));
        } catch (error) {
            if (!isCapacityError(error)) throw error;
            if (chunk.length > 1) {
                const mid = Math.ceil(chunk.length / 2);
                console.log(`  Earth Engine kapasite sınırı: ${chunk.length} tarihlik parça ikiye bölünüyor (${chunk[0]} → ${chunk[chunk.length - 1]})`);
                await run(chunk.slice(0, mid), tileScale);
                await run(chunk.slice(mid), tileScale);
                return;
            }
            if (tileScale < 16) {
                console.log(`  Earth Engine kapasite sınırı: ${chunk[0]} tileScale ${tileScale * 4} ile yeniden deneniyor`);
                await run(chunk, tileScale * 4);
                return;
            }
            throw error;
        }
        for (const { properties } of rows.features) {
            const id = String(properties[idProperty]);
            const row = out.get(id) ?? {};
            for (const [key, value] of Object.entries(properties)) {
                if (key === idProperty) continue;
                row[key.replace(/^\d+_/, '')] = typeof value === 'number' && Number.isFinite(value) ? value : null;
            }
            out.set(id, row);
        }
    };
    for (let i = 0; i < dates.length; i += datesPerChunk) await run(dates.slice(i, i + datesPerChunk), 2);
    return out;
}
