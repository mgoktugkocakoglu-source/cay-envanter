"""An approximate orthophoto of a drone video, from the camera solution drone_sfm and drone_georef already hold.

  .venv/Scripts/python.exe py/drone_ortho.py data/drone/<project>

Photogrammetry suites (OpenDroneMap, MicMac) build an orthophoto from a dense surface model. This step builds a
plain one from what the video gives: every ground cell takes its colour from the solved frame that looks at it
best (close, steep, not hidden behind the terrain), through the same ground surface the parcel overlay uses.

What it is not: a survey product. The surface is the bare ground from sparse model points, so roofs and tree crowns
lean away from the camera, and the whole image carries the georeference error of the model (out/georef.json). It
is a map-aligned view for a reviewer, and every cell keeps the time of the frame it came from.
"""
import json
import math
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import drone_georef  # noqa: E402

RULES = {
    'resolutionM': 0.5,
    # Frames are chosen per cell on this coarser grid, then drawn at resolutionM.
    'choiceCellM': 4.0,
    'maxDistanceM': 450,
    # Sine of the angle between the view ray and the ground plane: flatter looks smear the ground.
    'minViewSine': 0.3,
    'frameMarginPx': 24,
    # A cell is hidden when the ground rises above the ray to it by more than this.
    'occlusionMarginM': 3.0,
    'occlusionSamples': 24,
    'minPatchCells': 6,
    'fillHoleCells': 40,
    'terrainCellM': 2.0,
}


def main():
    ctx = drone_georef.main()
    root, images, time_of, cam = ctx['root'], ctx['images'], ctx['time_of'], ctx['cam']
    L, surface, cell, half = ctx['level'], ctx['surface'], ctx['cellM'], ctx['halfExtentM']
    e1, e2, up, s, t, scale = L['e1'], L['e2'], L['up'], L['s'], L['t'], L['scale']
    f, cx, cy, k1 = cam.params
    W, H = cam.width, cam.height
    out_dir = os.path.join(root, 'out')

    def ground(E, N):
        i, j = ((E + half) / cell - 0.5).astype(np.float32), ((N + half) / cell - 0.5).astype(np.float32)
        return cv2.remap(surface, i, j, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    def grid(step):
        n = int(2 * half / step)
        axis = (np.arange(n) + 0.5) * step - half
        E, N = np.meshgrid(axis, axis[::-1])  # row 0 is the north edge
        return n, E.astype(np.float32), N.astype(np.float32)

    def to_frame(im, E, N, Z):
        """Map cells → pixel coordinates in one frame, with the depth along the optical axis."""
        zc = E + 1j * N
        w = (zc - L['correct'](zc).reshape(zc.shape) - t) / s
        X = w.real[..., None] * e1 + w.imag[..., None] * e2 + (Z / scale)[..., None] * up
        M = im.cam_from_world().matrix()
        pc = X @ M[:, :3].T + M[:, 3]
        z = np.where(pc[..., 2] > 1e-6, pc[..., 2], np.nan)
        x, y = pc[..., 0] / z, pc[..., 1] / z
        d = 1 + k1 * (x * x + y * y)
        return f * x * d + cx, f * y * d + cy, z

    # 1. which frame shows each cell best
    step = RULES['choiceCellM']
    n, E, N = grid(step)
    Z = ground(E, N)
    best = np.full((n, n), np.inf, np.float32)
    choice = np.full((n, n), -1, np.int32)
    q = np.linspace(0.04, 0.96, RULES['occlusionSamples'], dtype=np.float32)
    m = RULES['frameMarginPx']
    for index, im in enumerate(images):
        C = im.projection_center()
        cz = s * complex(C @ e1, C @ e2) + t
        ce, cn, ch = cz.real, cz.imag, float(C @ up) * scale
        dist = np.sqrt((E - ce) ** 2 + (N - cn) ** 2 + (Z - ch) ** 2)
        sine = (ch - Z) / np.maximum(dist, 1e-3)
        near = (dist < RULES['maxDistanceM']) & (sine > RULES['minViewSine'])
        if not near.any():
            continue
        u, v, depth = to_frame(im, E, N, Z)
        with np.errstate(invalid='ignore'):
            ok = near & (u >= m) & (u < W - m) & (v >= m) & (v < H - m) & (depth > 0)
        rows, cols = np.nonzero(ok)
        if not len(rows):
            continue
        # Terrain between the camera and the cell: the ray must stay above the ground all the way.
        ee, nn, zz = E[rows, cols], N[rows, cols], Z[rows, cols]
        re = ce + (ee[:, None] - ce) * q
        rn = cn + (nn[:, None] - cn) * q
        rz = ch + (zz[:, None] - ch) * q
        clear = (ground(re, rn) < rz + RULES['occlusionMarginM']).all(1)
        rows, cols = rows[clear], cols[clear]
        score = (dist[rows, cols] / sine[rows, cols]).astype(np.float32)
        better = score < best[rows, cols]
        best[rows[better], cols[better]] = score[better]
        choice[rows[better], cols[better]] = index
    # Lone cells from another frame only add seams.
    covered = (choice >= 0).astype(np.uint8)
    covered = cv2.morphologyEx(covered, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    choice[covered == 0] = -1
    smooth = cv2.medianBlur(np.clip(choice, -1, 32000).astype(np.int16), 5)
    choice = np.where(choice >= 0, smooth, -1)
    # Small holes (a cell the terrain test dropped among cells it kept) take the frame of the nearest covered cell.
    count, labels, stats, _ = cv2.connectedComponentsWithStats((choice < 0).astype(np.uint8), connectivity=4)
    small = np.isin(labels, [i for i in range(1, count) if stats[i, cv2.CC_STAT_AREA] <= RULES['fillHoleCells']])
    _, nearest = cv2.distanceTransformWithLabels((choice < 0).astype(np.uint8), cv2.DIST_L2, 3, labelType=cv2.DIST_LABEL_PIXEL)
    source = np.zeros(nearest.max() + 1, np.int32)
    source[nearest[choice >= 0]] = choice[choice >= 0]
    choice = np.where(small, source[nearest], choice)
    used = [int(i) for i in np.unique(choice) if i >= 0 and (choice == i).sum() >= RULES['minPatchCells']]
    print(f'cells covered: {int((choice >= 0).sum())} of {n * n} · frames used: {len(used)} of {len(images)}')

    # 2. draw at full resolution, frame by frame
    res = RULES['resolutionM']
    k = int(round(step / res))
    nf, Ef, Nf = grid(res)
    Zf = ground(Ef, Nf)
    choice_f = np.repeat(np.repeat(choice, k, axis=0), k, axis=1)[:nf, :nf]
    ortho = np.zeros((nf, nf, 3), np.uint8)
    alpha = np.zeros((nf, nf), np.uint8)
    for index in used:
        mask = choice_f == index
        rows, cols = np.nonzero(mask)
        r0, r1, c0, c1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
        im = images[index]
        u, v, depth = to_frame(im, Ef[r0:r1, c0:c1], Nf[r0:r1, c0:c1], Zf[r0:r1, c0:c1])
        frame = cv2.imread(os.path.join(root, 'sfm', 'images', im.name))
        patch = cv2.remap(frame, np.nan_to_num(u, nan=-1).astype(np.float32), np.nan_to_num(v, nan=-1).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        sub = mask[r0:r1, c0:c1]
        ortho[r0:r1, c0:c1][sub] = patch[sub]
        alpha[r0:r1, c0:c1][sub] = 255

    # 3. crop to what is covered, write image, frame-time raster and metadata
    rows, cols = np.nonzero(alpha)
    r0, r1, c0, c1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
    r0, c0 = r0 // k * k, c0 // k * k
    ortho, alpha = ortho[r0:r1, c0:c1], alpha[r0:r1, c0:c1]
    cv2.imwrite(os.path.join(out_dir, 'ortho.webp'), np.dstack([ortho, alpha]), [cv2.IMWRITE_WEBP_QUALITY, 82])
    lon0, lat0 = ctx['origin']
    lonlat = lambda e, nn: [round(lon0 + e / (111320 * math.cos(math.radians(lat0))), 7), round(lat0 + nn / 110540, 7)]
    west, east = c0 * res - half, c1 * res - half
    north, south = half - r0 * res, half - r1 * res
    # Frame time per choice cell (tenths of a second, 0 = no data): lets a viewer jump from the map to the video.
    times = np.zeros((n, n), np.uint16)
    for index in used:
        times[choice == index] = int(round(time_of(images[index]) * 10))
    cr0, cr1, cc0, cc1 = r0 // k, -(-r1 // k), c0 // k, -(-c1 // k)
    cv2.imwrite(os.path.join(out_dir, 'ortho-times.png'), times[cr0:cr1, cc0:cc1])
    # The ground surface under the orthophoto, for a 3D view: heights relative to the lowest cell, 16 bit split over
    # two 8 bit channels (red = high byte, green = low byte) so a browser canvas can read it back.
    tstep = RULES['terrainCellM']
    tw, th = int((east - west) / tstep), int((north - south) / tstep)
    te = west + (np.arange(tw) + 0.5) * (east - west) / tw
    tn = north - (np.arange(th) + 0.5) * (north - south) / th
    TE, TN = np.meshgrid(te.astype(np.float32), tn.astype(np.float32))
    TZ = ground(TE, TN)
    zmin, zmax = float(TZ.min()), float(TZ.max())
    q16 = np.round((TZ - zmin) / max(zmax - zmin, 1e-6) * 65535).astype(np.uint16)
    cv2.imwrite(os.path.join(out_dir, 'ortho-height.png'), np.dstack([np.zeros_like(q16), q16 & 255, q16 >> 8]).astype(np.uint8))
    georef = json.load(open(os.path.join(out_dir, 'georef.json'), encoding='utf8'))
    meta = {
        'image': 'ortho.webp', 'width': int(c1 - c0), 'height': int(r1 - r0), 'resolutionM': res,
        'bounds': {'southWest': lonlat(west, south), 'northEast': lonlat(east, north)},
        'times': {'image': 'ortho-times.png', 'cellM': step, 'unit': 'ds',
                  'bounds': {'southWest': lonlat(cc0 * step - half, half - cr1 * step), 'northEast': lonlat(cc1 * step - half, half - cr0 * step)}},
        'terrain': {'image': 'ortho-height.png', 'width': tw, 'height': th, 'cellM': tstep, 'reliefM': round(zmax - zmin, 1),
                    'note': 'Zemin modeli videodan çözülen seyrek noktalardan çıkarıldı; yükseklikler görelidir (deniz seviyesine bağlı değil), yapı ve ağaç yüksekliği içermez.'},
        'coveredHa': round(float((alpha > 0).sum()) * res * res / 10000, 1),
        'framesUsed': len(used), 'shot': [time_of(images[0]), time_of(images[-1])],
        'georefRmsM': georef['rmsM'], 'georefMaxResidualM': georef['maxResidualM'],
        'rules': RULES,
        'method': 'Videonun çözülen karelerinden yaklaşık ortofoto: her zemin hücresi, onu en yakından ve en dik gören kareden renk alır. Zemin modeli seyrek noktalardan çıkarıldı; çatılar ve ağaç tepeleri kameradan uzağa doğru yatık görünür. Ölçüm ürünü değildir.',
    }
    json.dump(meta, open(os.path.join(out_dir, 'ortho.json'), 'w', encoding='utf8'), ensure_ascii=False, indent=1)

    # 4. a check sheet: cadastre and building footprints over the orthophoto
    sheet = ortho.copy()
    px = lambda ring: np.array([[(e - west) / res, (north - nn) / res] for e, nn in ring], np.int32)
    for ring in ctx['rings'].values():
        cv2.polylines(sheet, [px(ring)], True, (0, 255, 255), 1)
    for ring in ctx['footprints']:
        cv2.polylines(sheet, [px(ring)], True, (0, 0, 255), 1)
    os.makedirs(os.path.join(root, 'work'), exist_ok=True)
    cv2.imwrite(os.path.join(root, 'work', 'ortho-check.jpg'), sheet, [cv2.IMWRITE_JPEG_QUALITY, 85])
    print('written', meta['image'], meta['width'], 'x', meta['height'], '·', meta['coveredHa'], 'ha ·', os.path.getsize(os.path.join(out_dir, 'ortho.webp')) // 1024, 'kB')


if __name__ == '__main__':
    main()
