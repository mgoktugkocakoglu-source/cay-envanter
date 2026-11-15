import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DroneVerificationFile, DroneOrthophoto } from '../drone/model.ts';

/** Publish only existing relative heights, never the disabled oblique-video orthophoto. */
export function loadRemoteTerrain(neighborhoodDir: string) {
    const verification = join(neighborhoodDir, 'drone', 'verification.json');
    if (!existsSync(verification)) return null;
    const drone = JSON.parse(readFileSync(verification, 'utf8')) as DroneVerificationFile;
    for (const source of drone.sources) {
        if (!/^[a-z0-9-]+$/i.test(source.id)) continue;
        const metadata = join(process.cwd(), 'data', 'drone', source.id, 'out', 'ortho.json');
        if (!existsSync(metadata)) continue;
        const model = JSON.parse(readFileSync(metadata, 'utf8')) as DroneOrthophoto;
        const t = model.terrain;
        if (!t || !/^[\w-]+\.png$/.test(t.image) || !existsSync(join(neighborhoodDir, 'drone', 'evidence', source.id, t.image))) continue;
        return {
            sourceId: source.id, capturedAt: source.capturedAt, capturedAtNote: source.capturedAtNote,
            imageUrl: `${drone.imageryBaseUrl}${t.image}`, bounds: model.bounds,
            width: t.width, height: t.height, widthM: model.width * model.resolutionM, heightM: model.height * model.resolutionM,
            reliefM: t.reliefM, note: t.note,
            georefRmsM: model.georefRmsM, georefMaxResidualM: model.georefMaxResidualM,
        };
    }
    return null;
}
