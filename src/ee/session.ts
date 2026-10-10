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
