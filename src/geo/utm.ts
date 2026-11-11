/**
 * WGS84 ↔ UTM (northern hemisphere) with the Krüger series: millimetre accuracy inside a zone, no
 * external library. Sentinel-2 Level-2A tiles are gridded in UTM with 10 m pixel edges on multiples
 * of 10 m, so these let us lay the sensor's own lattice over a parcel.
 */

const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const E0 = 500_000;
const N = F / (2 - F);
const A_ = (A / (1 + N)) * (1 + (N * N) / 4 + N ** 4 / 64);
const ALPHA = [N / 2 - (2 * N * N) / 3 + (5 * N ** 3) / 16, (13 * N * N) / 48 - (3 * N ** 3) / 5, (61 * N ** 3) / 240];
const BETA = [N / 2 - (2 * N * N) / 3 + (37 * N ** 3) / 96, (N * N) / 48 + N ** 3 / 15, (17 * N ** 3) / 480];
const DELTA = [2 * N - (2 * N * N) / 3 - 2 * N ** 3, (7 * N * N) / 3 - (8 * N ** 3) / 5, (56 * N ** 3) / 15];
const RAD = Math.PI / 180;

export function utmZone(lon: number): number {
    return Math.floor((lon + 180) / 6) + 1;
}

export function toUtm(lat: number, lon: number, zone: number): { e: number; n: number } {
    const lon0 = ((zone - 1) * 6 - 180 + 3) * RAD;
    const phi = lat * RAD;
    const dl = lon * RAD - lon0;
    const k = (2 * Math.sqrt(N)) / (1 + N);
    const t = Math.sinh(Math.atanh(Math.sin(phi)) - k * Math.atanh(k * Math.sin(phi)));
    const xi = Math.atan2(t, Math.cos(dl));
    const eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
    let e = eta;
    let n = xi;
    for (let j = 1; j <= 3; j++) {
        const a = ALPHA[j - 1] as number;
        e += a * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
        n += a * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    }
    return { e: E0 + K0 * A_ * e, n: K0 * A_ * n };
}

/** → [lon, lat] (GeoJSON order). */
export function fromUtm(e: number, n: number, zone: number): [number, number] {
    const lon0 = ((zone - 1) * 6 - 180 + 3) * RAD;
    const xi = n / (K0 * A_);
    const eta = (e - E0) / (K0 * A_);
    let xi2 = xi;
    let eta2 = eta;
    for (let j = 1; j <= 3; j++) {
        const b = BETA[j - 1] as number;
        xi2 -= b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
        eta2 -= b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    }
    const chi = Math.asin(Math.sin(xi2) / Math.cosh(eta2));
    let phi = chi;
    for (let j = 1; j <= 3; j++) phi += (DELTA[j - 1] as number) * Math.sin(2 * j * chi);
    const lon = lon0 + Math.atan2(Math.sinh(eta2), Math.cos(xi2));
    return [lon / RAD, phi / RAD];
}
