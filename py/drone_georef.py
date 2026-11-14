"""Approximate cadastre overlay for an ordinary drone video: ties the structure-from-motion model to the map.

  .venv/Scripts/python.exe py/drone_sfm.py    data/drone/<project> <start_s> <end_s> [fps]   (camera poses, once)
  .venv/Scripts/python.exe py/drone_georef.py data/drone/<project>

The model from drone_sfm.py has no scale and no place on the earth. Here it is
  1. levelled      — a gimbal keeps the horizon level, so "up" is the direction no camera's right-axis points along;
  2. tied to the map — buildings marked on one frame (project.json → georef.buildings) get their 3D position from
                     the model and are matched to mapped building footprints; every pairing of two buildings is tried
                     and the similarity (scale, rotation, shift) that lands most buildings on a footprint wins;
  3. given a ground — a coarse surface from the low points of the model, so parcel corners get a height;
  4. used          — TKGM parcel outlines are projected into every solved frame.

The result is an APPROXIMATE overlay (metres, not centimetres): building footprints themselves sit a few metres off
on steep ground, the ground surface is coarse, and nothing here was surveyed. It shows which parcel is where in the
video; it does not give boundaries or areas. Survey-grade overlay needs RTK/PPK camera positions.
"""
import itertools
import json
import math
import os
import sys

import cv2
import numpy as np
import pycolmap

RULES = {
    # A marked building counts as matched when it lands within this many metres of a footprint centre.
    'matchRadiusM': 7.0,
    # Model points near a marked pixel that give the building its 3D position.
    'pickRadiusPx': 18,
    'minPickPoints': 3,
    'minMatches': 5,
    'groundCellM': 5.0,
    'groundPercentile': 20,
    'extentM': 220,
    'densifyM': 2.0,
}


def main():
    root = sys.argv[1]
    P = json.load(open(os.path.join(root, 'project.json'), encoding='utf8'))
    G = P['georef']
    out_dir = os.path.join(root, 'out')
    rec = pycolmap.Reconstruction(os.path.join(root, 'sfm', 'sparse'))
    cam = list(rec.cameras.values())[0]
    images = sorted((im for im in rec.images.values() if im.has_pose), key=lambda im: im.name)
    time_of = lambda im: int(im.name[1:7]) / 100

    # 1. level
    rights = np.array([im.cam_from_world().rotation.matrix()[0] for im in images])
    downs = np.array([im.cam_from_world().rotation.matrix()[1] for im in images])
    up = np.linalg.svd(rights)[2][-1]
    if np.dot(up, downs.mean(0)) > 0:
        up = -up
    e1 = np.cross(up, [1, 0, 0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(up, e1)
    tilt = float(np.degrees(np.arcsin(np.abs(rights @ up)).mean()))

    # 2. marked buildings → model positions → footprints
    ref = min(images, key=lambda im: abs(time_of(im) - G['t']))
    obs = [(p.xy, rec.points3D[p.point3D_id].xyz) for p in ref.points2D if p.has_point3D()]
    xy2, xyz = np.array([o[0] for o in obs]), np.array([o[1] for o in obs])
    picked = {}
    for name, (x, y) in G['buildings'].items():
        near = xyz[np.hypot(xy2[:, 0] - x, xy2[:, 1] - y) < RULES['pickRadiusPx']]
        if len(near) >= RULES['minPickPoints']:
            m = np.median(near, axis=0)
            picked[name] = complex(m @ e1, m @ e2)
    lib_dir = os.path.join('data', 'library', *[slug(P[k]) for k in ('province', 'district', 'neighborhood')])
    parcels = [json.loads(l) for l in open(os.path.join(lib_dir, 'parcels.ndjson'), encoding='utf8') if l.strip()]
    buildings = json.load(open(os.path.join(lib_dir, 'licence-audit', 'buildings.geojson'), encoding='utf8'))['features']
    lon0, lat0 = G['origin']
    en = lambda lon, lat: ((lon - lon0) * 111320 * math.cos(math.radians(lat0)), (lat - lat0) * 110540)
    ring_of = lambda g: g['coordinates'][0] if g['type'] == 'Polygon' else g['coordinates'][0][0]
    targets = {}
    for i, b in enumerate(buildings):
        c = np.array([en(*p[:2]) for p in ring_of(b['geometry'])]).mean(0)
        if abs(c[0]) < RULES['extentM'] and abs(c[1]) < RULES['extentM']:
            targets[f'footprint {i}'] = complex(*c)
    # Buildings without a footprint in the dataset can stand in by their own parcel (a mosque on its lot).
    for key in G.get('parcelBuildings', []):
        f = next(f for f in parcels if f['properties']['block'] + '/' + f['properties']['parcel'] == key)
        targets[f'parcel {key}'] = complex(*np.array([en(*p[:2]) for p in ring_of(f['geometry'])]).mean(0))
    best = None
    for (_, a1), (_, a2) in itertools.permutations(picked.items(), 2):
        for (_, b1), (_, b2) in itertools.permutations(targets.items(), 2):
            s = (b2 - b1) / (a2 - a1)
            t = b1 - s * a1
            used, pairs = set(), []
            for name, a in picked.items():
                d = {k: abs(s * a + t - c) for k, c in targets.items() if k not in used}
                k = min(d, key=d.get)
                if d[k] < RULES['matchRadiusM']:
                    used.add(k)
                    pairs.append((name, k, d[k]))
            score = (len(pairs), -sum(p[2] for p in pairs))
            if best is None or score > best[0]:
                best = (score, pairs)
    pairs = best[1]
    if len(pairs) < RULES['minMatches']:
        raise SystemExit(f'Only {len(pairs)} buildings matched; the model cannot be tied to the map.')
    # Least squares over the matched buildings; the worst one is dropped once if it stands far off the rest.
    for _ in range(2):
        a = np.array([picked[p[0]] for p in pairs])
        b = np.array([targets[p[1]] for p in pairs])
        s = np.sum((b - b.mean()) * np.conj(a - a.mean())) / np.sum(np.abs(a - a.mean()) ** 2)
        t = b.mean() - s * a.mean()
        res = np.abs(s * a + t - b)
        if len(pairs) > RULES['minMatches'] and res.max() > 2.5 * np.median(res) and res.max() > 4:
            pairs.pop(int(res.argmax()))
        else:
            break
    scale = abs(s)
    rms = float(np.sqrt(np.mean(res ** 2)))
    print(f'level: mean camera roll {tilt:.2f}° · {len(pairs)} of {len(picked)} marked buildings matched · rms {rms:.1f} m · scale {scale:.1f} m/unit')

    # 3. ground surface from the model's low points
    pts = np.array([p.xyz for p in rec.points3D.values() if p.track.length() >= 4 and p.error < 1.5])
    zz = s * (pts @ e1 + 1j * (pts @ e2)) + t
    E, N, Z = zz.real, zz.imag, (pts @ up) * scale
    cell, half = RULES['groundCellM'], RULES['extentM']
    n = int(2 * half / cell)
    gi, gj = ((E + half) / cell).astype(int), ((N + half) / cell).astype(int)
    ok = (gi >= 0) & (gi < n) & (gj >= 0) & (gj < n)
    ground = np.full((n, n), np.nan)
    order = np.lexsort((gi[ok], gj[ok]))
    keys = gj[ok][order] * n + gi[ok][order]
    for chunk in np.split(order, np.flatnonzero(np.diff(keys)) + 1):
        if len(chunk) >= 3:
            ground[gj[ok][chunk[0]], gi[ok][chunk[0]]] = np.percentile(Z[ok][chunk], RULES['groundPercentile'])
    hole = np.isnan(ground).astype(np.uint8)
    surface = cv2.GaussianBlur(cv2.inpaint(np.nan_to_num(ground, nan=float(np.nanmedian(ground))).astype(np.float32), hole, 5, cv2.INPAINT_NS), (0, 0), 1.0)

    def height(e, nn):
        i, j = np.clip((e + half) / cell - 0.5, 0, n - 1.001), np.clip((nn + half) / cell - 0.5, 0, n - 1.001)
        i0, j0 = int(i), int(j)
        fx, fy = i - i0, j - j0
        return float(surface[j0, i0] * (1 - fx) * (1 - fy) + surface[j0, i0 + 1] * fx * (1 - fy) + surface[j0 + 1, i0] * (1 - fx) * fy + surface[j0 + 1, i0 + 1] * fx * fy)

    def project(im, ring):
        dense = []
        for (a1, b1), (a2, b2) in zip(ring[:-1], ring[1:]):
            k = max(int(math.hypot(a2 - a1, b2 - b1) / RULES['densifyM']), 1)
            dense += [(a1 + (a2 - a1) * q / k, b1 + (b2 - b1) * q / k) for q in range(k)]
        T = im.cam_from_world()
        uv = []
        for e, nn in dense:
            w = (complex(e, nn) - t) / s
            pc = T * (w.real * e1 + w.imag * e2 + (height(e, nn) / scale) * up)
            if pc[2] <= 0:
                return None
            uv.append(np.asarray(cam.img_from_cam(pc)).reshape(-1)[:2])
        return np.array(uv, np.float32)

    # 4. project: every parcel in view on the reference frame, the analysed parcels on every frame
    W, H = cam.width, cam.height
    rings = {f['properties']['block'] + '/' + f['properties']['parcel']: [en(*p[:2]) for p in ring_of(f['geometry'])] for f in parcels}
    near = {k: r for k, r in rings.items() if abs(np.mean(r, axis=0)[0]) < RULES['extentM'] * 0.7 and abs(np.mean(r, axis=0)[1]) < RULES['extentM'] * 0.7}
    analysis_path = os.path.join(out_dir, 'analysis.json')
    analysis = json.load(open(analysis_path, encoding='utf8')) if os.path.exists(analysis_path) else {'parcels': []}
    hand = {p['parcel']: np.array(p['outline']['polygon'], np.int32) for p in analysis['parcels'] if abs(p['outline']['t'] - time_of(ref)) < 0.2}
    frame = cv2.imread(os.path.join(root, 'sfm', 'images', ref.name))
    in_view = []
    for k, r in near.items():
        uv = project(ref, r)
        if uv is None or uv[:, 0].max() < 0 or uv[:, 0].min() > W or uv[:, 1].max() < 0 or uv[:, 1].min() > H:
            continue
        inside = float(np.mean((uv[:, 0] >= 0) & (uv[:, 0] < W) & (uv[:, 1] >= 0) & (uv[:, 1] < H)))
        if inside >= 0.9:
            in_view.append(k)
        hot = k in hand
        cv2.polylines(frame, [uv.astype(np.int32)], True, (0, 255, 255) if hot else (255, 255, 255), 2 if hot else 1)
        if hot or (inside >= 0.9 and cv2.contourArea(uv) > 2500):
            c = uv.mean(0).astype(int)
            cv2.putText(frame, k, (int(c[0]) - 20, int(c[1])), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 3)
            cv2.putText(frame, k, (int(c[0]) - 20, int(c[1])), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255) if hot else (255, 255, 255), 1)
    result = {}
    for k, poly in hand.items():
        cv2.polylines(frame, [poly], True, (0, 0, 255), 2)
        m1, m2 = np.zeros((H, W), np.uint8), np.zeros((H, W), np.uint8)
        cv2.fillPoly(m1, [poly], 1)
        cv2.fillPoly(m2, [project(ref, rings[k]).astype(np.int32)], 1)
        track = []
        for im in images:
            uv = project(im, rings[k])
            if uv is None or np.mean((uv[:, 0] >= 0) & (uv[:, 0] < W) & (uv[:, 1] >= 0) & (uv[:, 1] < H)) < 0.5:
                continue
            simple = cv2.approxPolyDP(uv.reshape(-1, 1, 2), 1.0, True).reshape(-1, 2)
            track.append({'t': time_of(im), 'polygon': [[round(float(x), 1), round(float(y), 1)] for x, y in simple]})
        result[k] = {'handOverlap': {'iou': round(float((m1 & m2).sum() / (m1 | m2).sum()), 2), 'handInsideCadastre': round(float((m1 & m2).sum() / m1.sum()), 2), 'cadastreInsideHand': round(float((m1 & m2).sum() / m2.sum()), 2)}, 'track': track}
        print(k, result[k]['handOverlap'], 'frames', len(track))
    cv2.imwrite(os.path.join(out_dir, 'cadastre-reference.jpg'), frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    json.dump({
        'method': 'Videodan kamera konumları çözüldü (structure from motion); model, karede işaretlenen binaların harita üzerindeki bina izleriyle eşleştirilmesiyle haritaya bağlandı. Yaklaşık bindirmedir; ölçüm değildir.',
        'rules': RULES,
        'model': {'frames': len(images), 'points': rec.num_points3D(), 'reprojectionErrorPx': round(rec.compute_mean_reprojection_error(), 2), 'shot': [time_of(images[0]), time_of(images[-1])], 'meanRollDeg': round(tilt, 2)},
        'controls': [{'building': p[0], 'target': p[1], 'residualM': round(float(r), 1)} for p, r in zip(pairs, res)],
        'markedBuildings': len(picked), 'rmsM': round(rms, 1), 'maxResidualM': round(float(res.max()), 1), 'scaleMPerUnit': round(scale, 2),
        'referenceT': time_of(ref), 'referenceImage': 'cadastre-reference.jpg', 'parcelsInView': sorted(in_view), 'parcels': result,
    }, open(os.path.join(out_dir, 'georef.json'), 'w', encoding='utf8'), ensure_ascii=False)
    print('parcels fully in view on the reference frame:', len(in_view))


def slug(text):
    table = str.maketrans('çğıöşüÇĞİÖŞÜ', 'cgiosuCGIOSU')
    return ''.join(ch if ch.isalnum() else '-' for ch in text.translate(table).lower()).strip('-')


if __name__ == '__main__':
    main()
