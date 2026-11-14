"""Every cadastral parcel a drone video shows, straight from the video: no hand-marked stills.

  .venv/Scripts/python.exe py/drone_sfm.py     data/drone/<project> <start_s> <end_s> [fps]   (camera poses, once per shot)
  .venv/Scripts/python.exe py/drone_parcels.py data/drone/<project>

drone_georef ties the video to the map and projects the TKGM outlines into every solved frame. This step then
  1. keeps the parcels the shot really shows: outline inside the frame AND model points on that ground seen by
     that frame (a parcel behind a building or a ridge projects into the frame too, but nothing of it is seen);
  2. picks a few frames per parcel (largest on screen, a couple of seconds apart) and cuts evidence crops;
  3. runs the experimental pixel classifier inside the projected outline;
  4. writes out/analysis.json in the format verify-drone reads, with the outline as `kind: cadastre`.

The outline is an approximate projection (a few metres off): the smaller the parcel, the more of a neighbour it
holds. Parcels below `minParcelM2` are analysed but flagged, and nothing here measures an area.
"""
import json
import math
import os
import subprocess
import sys

import cv2
import numpy as np
from sklearn.ensemble import RandomForestClassifier

sys.path.insert(0, os.path.dirname(__file__))
import drone_georef  # noqa: E402
from drone_verify import CLASSES, FEATURE_NAMES, LABEL_CLASS, TINT, describe, features, frame_at, homography, warp  # noqa: E402

RULES = {
    'framesPerParcel': 3,
    'frameGapS': 2.0,
    'minPixels': 900,
    # Model points on the parcel's ground that the frame must have seen.
    'minSeenPoints': 4,
    'edgeMarginPx': 4,
    # Below this the projection error (metres) is a large part of the parcel: analysed, but flagged.
    'minParcelM2': 400,
    'uncertainProbability': 0.5,
    'teaPresentShare': 0.55,
    'teaAbsentShare': 0.25,
    'maxSpread': 0.25,
    'samplesPerRect': 1200,
    'trees': 150,
    'shotMarginS': 5,
    'clipMarginS': 0.0,
}


def inside_polygon(points, ring):
    return np.array([cv2.pointPolygonTest(ring, (float(x), float(y)), False) >= 0 for x, y in points])


def main():
    ctx = drone_georef.main()
    root, P, rec, images, time_of, project = ctx['root'], ctx['project'], ctx['rec'], ctx['images'], ctx['time_of'], ctx['project_ring']
    out_dir = os.path.join(root, 'out')
    for f in os.listdir(out_dir):
        if f.endswith(('-frame.jpg', '-classes.jpg', '-reference.jpg')):
            os.remove(os.path.join(out_dir, f))
    video = os.path.join(root, P['source']['file'])
    cap = cv2.VideoCapture(video)
    fps, count = cap.get(cv2.CAP_PROP_FPS), cap.get(cv2.CAP_PROP_FRAME_COUNT)
    W, H = int(cap.get(3)), int(cap.get(4))
    duration = count / fps
    rng = np.random.default_rng(7)
    lo, hi = time_of(images[0]), time_of(images[-1])

    # ── which frames saw which ground: model points in map coordinates with the frames that observed them ──
    seen_xy, seen_by = [], []
    for p in rec.points3D.values():
        if p.track.length() < 4 or p.error > 1.5:
            continue
        z = ctx['to_map'](p.xyz)
        seen_xy.append((z.real, z.imag))
        seen_by.append({e.image_id for e in p.track.elements})
    seen_xy = np.array(seen_xy, np.float32)

    # ── classifier: rectangles of this shot, tested frame against frame (same as drone_verify) ──
    samples = {}
    for r in P['training']:
        if not lo - RULES['shotMarginS'] <= r['t'] <= hi + RULES['shotMarginS']:
            samples.setdefault('other', []).append(r)
            continue
        samples.setdefault(r['t'], []).append(r)

    def sample(rects):
        X, y, meta = [], [], []
        for r in rects:
            x0, y0, x1, y1 = r['rect']
            feats = features(frame_at(cap, r['t']))[y0:y1, x0:x1].reshape(-1, len(FEATURE_NAMES))
            pick = rng.choice(len(feats), size=min(RULES['samplesPerRect'], len(feats)), replace=False)
            X.append(feats[pick])
            y.append(np.full(len(pick), CLASSES.index(LABEL_CLASS[r['label']])))
            meta.append(r)
        return X, y, meta

    data = {k: sample(v) for k, v in samples.items()}
    in_shot = sorted(k for k in data if k != 'other')
    stack = lambda ks: (np.vstack([x for k in ks for x in data[k][0]]), np.concatenate([y for k in ks for y in data[k][1]]))
    fit = lambda X, y: RandomForestClassifier(n_estimators=RULES['trees'], min_samples_leaf=5, class_weight='balanced', random_state=7, n_jobs=-1).fit(X, y)
    tea = CLASSES.index('tea')
    score = lambda c: {'pixels': int(c.sum()), 'accuracy': round(float(np.trace(c) / max(c.sum(), 1)), 3), 'teaRecall': round(float(c[tea, tea] / max(c[tea].sum(), 1)), 3), 'teaPrecision': round(float(c[tea, tea] / max(c[:, tea].sum(), 1)), 3), 'confusion': c.tolist()}
    confusion = np.zeros((len(CLASSES), len(CLASSES)), int)
    reference = []
    for held in in_shot:
        m = fit(*stack([k for k in in_shot if k != held]))
        for X, y, r in zip(*data[held]):
            pred = m.predict(X)
            for a, b in zip(y, pred):
                confusion[a, b] += 1
            reference.append({'t': r['t'], 'label': r['label'], 'rect': r['rect'], 'teaShare': round(float(np.mean(pred == tea)), 3)})
    model = fit(*stack(in_shot))
    transfer = np.zeros_like(confusion)
    if 'other' in data:
        Xo, yo = stack(['other'])
        for a, b in zip(yo, model.predict(Xo)):
            transfer[a, b] += 1
    ref_tea = sorted(r['teaShare'] for r in reference if r['label'] == 'tea')
    ref_other = sorted(r['teaShare'] for r in reference if r['label'] in ('woody', 'low_other'))
    validation = {
        'method': 'Aynı çekimin kareleri arasında çapraz sınama (bir karede eğitilip diğerinde denendi). Eğitim dikdörtgenleri video karelerinde gözle işaretlendi; saha etiketi yok.',
        'classes': CLASSES, 'frames': in_shot, **score(confusion),
        'trainingRectangles': {c: sum(1 for k in in_shot for r in data[k][2] if LABEL_CLASS[r['label']] == c) for c in CLASSES},
        'referenceAreas': reference,
        'referenceTeaRange': [ref_tea[0], float(np.median(ref_tea)), ref_tea[-1]] if ref_tea else None,
        'referenceOtherRange': [ref_other[0], float(np.median(ref_other)), ref_other[-1]] if ref_other else None,
        'transfer': {'frames': sorted({r['t'] for r in data['other'][2]}), **score(transfer), 'note': 'Aynı model videonun başka çekimlerindeki işaretli alanlarda: farklı ışık ve yükseklikte ne kadar tuttuğu.'} if 'other' in data else None,
        'topFeatures': [{'feature': FEATURE_NAMES[i], 'importance': round(float(model.feature_importances_[i]), 3)} for i in np.argsort(-model.feature_importances_)[:6]],
    }
    print('classifier (in-shot cross-frame):', {k: validation[k] for k in ('accuracy', 'teaRecall', 'teaPrecision')})

    # ── per parcel: where it is seen, which frames, what the classifier reads ──
    hypotheses = P.get('hypotheses', {})
    feature_cache = {}

    def features_of(im):
        if im.name not in feature_cache:
            if len(feature_cache) > 40:
                feature_cache.clear()
            frame = cv2.imread(os.path.join(root, 'sfm', 'images', im.name))
            feature_cache[im.name] = (frame, features(frame))
        return feature_cache[im.name]

    results, skipped = [], {'not_in_frame': 0, 'not_seen': 0}
    m = RULES['edgeMarginPx']
    for key, ring in sorted(ctx['rings'].items()):
        ring_np = np.array(ring, np.float32)
        area_m2 = float(cv2.contourArea(ring_np))
        box = (seen_xy[:, 0] >= ring_np[:, 0].min()) & (seen_xy[:, 0] <= ring_np[:, 0].max()) & (seen_xy[:, 1] >= ring_np[:, 1].min()) & (seen_xy[:, 1] <= ring_np[:, 1].max())
        idx = np.flatnonzero(box)
        idx = idx[inside_polygon(seen_xy[idx], ring_np)] if len(idx) else idx
        track, candidates = [], []
        for im in images:
            uv = project(im, ring)
            if uv is None:
                continue
            within = (uv[:, 0] >= m) & (uv[:, 0] < W - m) & (uv[:, 1] >= m) & (uv[:, 1] < H - m)
            if within.mean() < 0.5:
                continue
            seen = sum(1 for i in idx if im.image_id in seen_by[i])
            if seen < RULES['minSeenPoints']:
                continue
            simple = cv2.approxPolyDP(uv.reshape(-1, 1, 2), 1.0, True).reshape(-1, 2)
            track.append({'t': time_of(im), 'polygon': [[round(float(x), 1), round(float(y), 1)] for x, y in simple]})
            if within.all() and cv2.contourArea(uv) >= RULES['minPixels']:
                candidates.append((cv2.contourArea(uv), im, uv))
        if not track:
            skipped['not_seen' if len(idx) < RULES['minSeenPoints'] else 'not_in_frame'] += 1
            continue
        if not candidates:
            skipped['not_in_frame'] += 1
            continue
        chosen = []
        for a, im, uv in sorted(candidates, key=lambda c: -c[0]):
            if len(chosen) >= RULES['framesPerParcel']:
                break
            if all(abs(time_of(im) - time_of(c[1])) >= RULES['frameGapS'] for c in chosen):
                chosen.append((a, im, uv))
        chosen.sort(key=lambda c: time_of(c[1]))
        best_t = time_of(max(chosen, key=lambda c: c[0])[1])
        slug = key.replace('/', '-')
        frames = []
        for a, im, uv in chosen:
            frame, feats = features_of(im)
            t = time_of(im)
            mask = np.zeros((H, W), np.uint8)
            cv2.fillPoly(mask, [uv.astype(np.int32)], 255)
            x, y0, w, h = cv2.boundingRect(uv.astype(np.int32))
            pad = int(max(w, h) * 0.5) + 24
            xa, ya, xb, yb = max(x - pad, 0), max(y0 - pad, 0), min(x + w + pad, W), min(y0 + h + pad, H)
            proba = model.predict_proba(feats[ya:yb, xa:xb].reshape(-1, len(FEATURE_NAMES))).reshape(yb - ya, xb - xa, -1)
            label = model.classes_[np.argmax(proba, axis=2)]
            label[np.max(proba, axis=2) < RULES['uncertainProbability']] = -1
            inside = mask[ya:yb, xa:xb] > 0
            total = max(int(inside.sum()), 1)
            shares = {c: round(float(np.sum(inside & (label == i)) / total), 3) for i, c in enumerate(CLASSES)}
            shares['uncertain'] = round(float(np.sum(inside & (label == -1)) / total), 3)
            sharp = float(cv2.Laplacian(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), cv2.CV_64F)[mask > 0].var())
            crop = frame[ya:yb, xa:xb].copy()
            tint = crop.copy()
            for i, c in enumerate(CLASSES):
                tint[label == i] = TINT[c]
            shown = cv2.addWeighted(crop, 0.55, tint, 0.45, 0)
            shown[~inside] = (crop[~inside] * 0.55).astype(np.uint8)
            zoom = min(max(1.0, 520 / max(crop.shape[:2])), 4.0)
            local = ((uv - [xa, ya]) * zoom).astype(np.int32)
            big = lambda im_: cv2.resize(im_, None, fx=zoom, fy=zoom, interpolation=cv2.INTER_CUBIC)
            clean, tinted = big(crop), big(shown)
            for im_ in (clean, tinted):
                cv2.polylines(im_, [local], True, (0, 255, 255), 2)
            name = f'{slug}-{int(round(t * 10)):05d}'
            cv2.imwrite(os.path.join(out_dir, name + '-frame.jpg'), clean, [cv2.IMWRITE_JPEG_QUALITY, 88])
            cv2.imwrite(os.path.join(out_dir, name + '-classes.jpg'), tinted, [cv2.IMWRITE_JPEG_QUALITY, 88])
            frames.append({'t': t, 'isReference': t == best_t, 'pixels': int(inside.sum()), 'inliers': None, 'sharpness': round(sharp, 1), 'shares': shares, 'frame': name + '-frame.jpg', 'classes': name + '-classes.jpg'})
        tea_shares = [f['shares']['tea'] for f in frames]
        median, spread = float(np.median(tea_shares)), float(max(tea_shares) - min(tea_shares))
        if spread > RULES['maxSpread']:
            cls = 'uncertain'
        elif median >= RULES['teaPresentShare']:
            cls = 'tea_present'
        elif median <= RULES['teaAbsentShare']:
            cls = 'tea_not_found'
        else:
            cls = 'partial'
        ref_frame = next(f for f in frames if f['isReference'])
        ref_poly = next(k for k in track if k['t'] == best_t)['polygon']
        results.append({
            'parcel': key, 'hypothesis': hypotheses.get(key), 'class': cls, 'confidence': 'low',
            'teaShareMedian': round(median, 3), 'teaShareSpread': round(spread, 3),
            'otherShares': {c: round(float(np.median([f['shares'][c] for f in frames])), 3) for c in ['other_vegetation', 'built', 'uncertain']},
            'match': None, 'visible': [track[0]['t'], track[-1]['t']], 'trackedFrames': len(track), 'frames': frames, 'track': track,
            'geometryAreaM2': round(area_m2), 'small': area_m2 < RULES['minParcelM2'], 'seenPoints': int(len(idx)),
            'outline': {'t': best_t, 'frame': [W, H], 'polygon': ref_poly, 'reference': ref_frame['frame'], 'kind': 'cadastre'},
        })
    print(f"parcels analysed: {len(results)} · left out: {skipped}")

    # ── what the video can support, and the clip the site plays ──
    moves, sharp, prev = [], [], None
    t = lo
    while t <= hi:
        f = frame_at(cap, t)
        d = describe(f)
        sharp.append(float(cv2.Laplacian(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()))
        if prev is not None:
            Hm, inl = homography(prev, d)
            if Hm is not None and inl >= 40:
                c = warp([[W / 2, H / 2]], Hm)[0]
                moves.append(float(np.hypot(c[0] - W / 2, c[1] - H / 2)) / W)
        prev = d
        t += 2.0
    capture = {
        'width': W, 'height': H, 'fps': round(fps, 2), 'durationS': round(duration, 1), 'bitrateMbps': round(os.path.getsize(video) * 8 / duration / 1e6, 2), 'shot': [lo, hi],
        'sharpnessMedian': round(float(np.median(sharp)), 1), 'shiftPerSecondShare': round(float(np.median(moves)) / 2, 3) if moves else None, 'overlapAtOneSecond': round(1 - float(np.median(moves)) / 2, 3) if moves else None,
        'hasFlightLog': False, 'hasCameraCalibration': False, 'georeference': 'approximate',
    }
    clip = None
    try:
        import imageio_ffmpeg
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-loglevel', 'error', '-ss', str(lo), '-i', video, '-t', str(hi - lo), '-an', '-vf', 'fps=30', '-c:v', 'libx264', '-crf', '26', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', os.path.join(out_dir, 'clip.mp4')], check=True)
        clip = {'file': 'clip.mp4', 'start': lo, 'end': hi, 'width': W, 'height': H, 'bytes': os.path.getsize(os.path.join(out_dir, 'clip.mp4'))}
    except Exception as error:  # the clip is a convenience; the analysis stands without it
        print('clip not written:', error)
    project_info = {k: P[k] for k in ('id', 'title', 'province', 'district', 'neighborhood', 'capturedAt', 'capturedAtNote', 'trainingNote')}
    project_info['source'] = {**P['source'], 'georeference': 'approximate'}
    json.dump({'project': project_info, 'rules': RULES, 'capture': capture, 'clip': clip, 'validation': validation, 'parcels': results}, open(os.path.join(out_dir, 'analysis.json'), 'w', encoding='utf8'), ensure_ascii=False)
    print('written', os.path.join(out_dir, 'analysis.json'), 'clip', clip)


if __name__ == '__main__':
    main()
