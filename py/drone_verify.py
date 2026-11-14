"""Drone-supported land verification, first prototype: an ordinary drone VIDEO with no flight log.

  .venv/Scripts/python.exe py/drone_verify.py data/drone/<project>

Steps (project.json describes the video, the hand-marked stills and the training rectangles):
  1. match   — each hand-marked still is located in the video (SIFT + homography) and its outline carried to the
               clean frame. The outline is the marker's drawing, NOT the cadastral boundary.
  2. track   — the outline is followed through the shot, giving the time range the parcel is on screen.
  3. classify— a small pixel classifier (colour + texture, random forest) trained on rectangles marked by eye on
               frames of the same video; tested by leaving one frame out. No field labels are involved.
  4. report  — per parcel: class shares per analysed frame, agreement between frames, evidence images, and what the
               video can and cannot support (resolution, sharpness, overlap; no coordinates, no scale).

Everything here is a preliminary visual assessment. Without camera positions the video gives no coordinates,
no areas and no cadastral boundary; those need RTK-georeferenced orthophotos (see sources[].georeference).
"""
import json
import os
import sys

import cv2
import numpy as np
from sklearn.ensemble import RandomForestClassifier

CLASSES = ['tea', 'other_vegetation', 'built']
# Training labels → classes. Trees, scrub, weeds and garden crops are one class: the few garden samples in the
# video are too alike to tea at this resolution to stand as a class of their own.
LABEL_CLASS = {'tea': 'tea', 'woody': 'other_vegetation', 'low_other': 'other_vegetation', 'built': 'built'}
RULES = {
    'trackStepS': 0.5,
    'minInliers': 40,
    # Keypoints for tracking come from the outline's bounding box widened by this share of its size.
    'trackPad': 0.8,
    # A tracked outline whose area changes more than this against the reference is rejected.
    'maxAreaChange': 2.5,
    'analysisFrames': 6,
    'analysisGapS': 2.0,
    'minParcelPixels': 1500,
    'uncertainProbability': 0.5,
    # Parcel class from the share of tea among the classified pixels inside the outline (median over frames).
    'teaPresentShare': 0.55,
    'teaAbsentShare': 0.25,
    # Training frames within this many seconds of the tracked range count as the same shot.
    'shotMarginS': 5,
    # Frames must agree within this spread, else the parcel is "uncertain".
    'maxSpread': 0.25,
    'samplesPerRect': 1200,
    'trees': 150,
}
TINT = {'tea': (60, 200, 60), 'other_vegetation': (0, 215, 255), 'built': (150, 150, 150)}


def frame_at(cap, t):
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, f = cap.read()
    return f if ok else None


def outline_of(still):
    """Closed red line drawn on the still → polygon (inner edge pushed out by half the line width)."""
    b, g, r = [still[:, :, i].astype(int) for i in range(3)]
    red = ((r > 150) & (g < 120) & (b < 120)).astype(np.uint8) * 255
    for k in (1, 5, 9, 13, 17, 21, 27):
        closed = cv2.morphologyEx(red, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
        cs, hier = cv2.findContours(closed, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
        holes = [c for c, h in zip(cs, hier[0]) if h[3] >= 0] if hier is not None else []
        if holes and cv2.contourArea(max(holes, key=cv2.contourArea)) > 1500:
            fill = np.zeros_like(red)
            cv2.drawContours(fill, [max(holes, key=cv2.contourArea)], -1, 255, -1)
            fill = cv2.dilate(fill, np.ones((3, 3), np.uint8))
            cs, _ = cv2.findContours(fill, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            return cv2.approxPolyDP(max(cs, key=cv2.contourArea), 1.0, True).reshape(-1, 2).astype(np.float32), red
    raise SystemExit('The red outline on the still is not a closed line.')


SIFT = cv2.SIFT_create(4000)
BF = cv2.BFMatcher()


def describe(img, mask=None):
    return SIFT.detectAndCompute(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), mask)


def homography(a, b):
    """Homography taking points of a to b, with the RANSAC inlier count."""
    (ka, da), (kb, db) = a, b
    if da is None or db is None or len(ka) < 8 or len(kb) < 8:
        return None, 0
    good = [m for m, n in BF.knnMatch(da, db, k=2) if m.distance < 0.75 * n.distance]
    if len(good) < 8:
        return None, 0
    H, mk = cv2.findHomography(np.float32([ka[m.queryIdx].pt for m in good]), np.float32([kb[m.trainIdx].pt for m in good]), cv2.RANSAC, 4.0)
    return H, (int(mk.sum()) if mk is not None else 0)


def warp(poly, H):
    return cv2.perspectiveTransform(np.float32(poly).reshape(-1, 1, 2), H).reshape(-1, 2)


def features(bgr):
    """Per-pixel colour and texture, kept relative to local brightness so that shade matters less."""
    f = bgr.astype(np.float32)
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
    L = lab[:, :, 0]
    blur = lambda x, k: cv2.blur(x, (k, k))
    exg = (2 * f[:, :, 1] - f[:, :, 2] - f[:, :, 0]) / (f.sum(axis=2) + 1)
    out = [blur(lab[:, :, 1], 9), blur(lab[:, :, 2], 9), blur(hsv[:, :, 1], 9), blur(exg, 9), blur(L, 15)]
    means = {k: blur(L, k) for k in (5, 15, 31)}
    stds = {k: np.sqrt(np.maximum(blur(L * L, k) - means[k] ** 2, 0)) for k in (5, 15, 31)}
    for k in (5, 15, 31):
        out.append(stds[k] / (means[k] + 8))
    mag = cv2.magnitude(cv2.Sobel(L, cv2.CV_32F, 1, 0), cv2.Sobel(L, cv2.CV_32F, 0, 1))
    out.append(blur(mag, 9) / (means[15] + 8))
    out.append(stds[5] / (stds[31] + 1))
    # Spread of colour, not only of brightness: mixed scrub varies in hue, a tea canopy does not.
    for ch in (lab[:, :, 1], lab[:, :, 2]):
        out.append(np.sqrt(np.maximum(blur(ch * ch, 15) - blur(ch, 15) ** 2, 0)))
    # Planting rows: gradients inside a tea garden share one direction (coherent structure tensor); tree crowns,
    # scrub and weeds have none.
    Ls = cv2.GaussianBlur(L, (0, 0), 1.0)
    gx, gy = cv2.Sobel(Ls, cv2.CV_32F, 1, 0), cv2.Sobel(Ls, cv2.CV_32F, 0, 1)
    for k in (15, 31):
        jxx, jyy, jxy = blur(gx * gx, k), blur(gy * gy, k), blur(gx * gy, k)
        out.append(np.sqrt((jxx - jyy) ** 2 + 4 * jxy ** 2) / (jxx + jyy + 1))
    return np.dstack(out)


FEATURE_NAMES = ['a', 'b', 'saturation', 'excess_green', 'lightness', 'texture_5', 'texture_15', 'texture_31', 'edges', 'fine_vs_coarse', 'a_spread', 'b_spread', 'row_coherence_15', 'row_coherence_31']


def main():
    root = sys.argv[1]
    P = json.load(open(os.path.join(root, 'project.json'), encoding='utf8'))
    out_dir = os.path.join(root, 'out')
    os.makedirs(out_dir, exist_ok=True)
    video = os.path.join(root, P['source']['file'])
    cap = cv2.VideoCapture(video)
    fps, n = cap.get(cv2.CAP_PROP_FPS), cap.get(cv2.CAP_PROP_FRAME_COUNT)
    width, height = int(cap.get(3)), int(cap.get(4))
    duration = n / fps
    rng = np.random.default_rng(7)

    # ── 1. match the marked stills ──
    parcels = []
    for m in P['marks']:
        still = cv2.imread(os.path.join(root, m['still']))
        outline, red = outline_of(still)
        desc = describe(still, cv2.bitwise_not(cv2.dilate(red, np.ones((9, 9), np.uint8))))
        best = None
        for step in (1.0, 0.1):
            a, b = P['search'] if step == 1.0 else (best[1] - 0.9, best[1] + 0.9)
            t = a
            while t <= b + 1e-6:
                f = frame_at(cap, t)
                if f is not None:
                    H, inl = homography(desc, describe(f))
                    if H is not None and (best is None or inl > best[0]):
                        best = (inl, round(t, 2), H)
                t += step
        inl, t, H = best
        parcels.append({'parcel': m['parcel'], 'hypothesis': m.get('hypothesis'), 'still': m['still'], 'refT': t, 'refInliers': inl, 'stillKeypoints': len(desc[0]), 'refPolygon': warp(outline, H)})
        print(f"{m['parcel']}: still found at {t:.2f} s ({inl} of {len(desc[0])} keypoints agree)")

    # ── 2. track every outline through the shot ──
    for p in parcels:
        ref = frame_at(cap, p['refT'])
        # Only keypoints around the parcel: one homography can describe that piece of ground, not the whole hillside.
        x, y0, w, h = cv2.boundingRect(p['refPolygon'].astype(np.int32))
        pad = int(max(w, h) * RULES['trackPad'])
        local = np.zeros((height, width), np.uint8)
        local[max(y0 - pad, 0):y0 + h + pad, max(x - pad, 0):x + w + pad] = 255
        ref_desc = describe(ref, local)
        ref_area = cv2.contourArea(p['refPolygon'])
        track = {p['refT']: (p['refPolygon'], len(ref_desc[0]))}
        for direction in (-1, 1):
            t, misses = p['refT'], 0
            while misses < 4:
                t = round(t + direction * RULES['trackStepS'], 2)
                f = frame_at(cap, t) if 0 <= t < duration else None
                if f is None:
                    break
                # Always against the reference frame, never frame to frame: chained homographies drift off the parcel.
                H, inl = homography(ref_desc, describe(f))
                poly = warp(p['refPolygon'], H) if H is not None and inl >= RULES['minInliers'] else None
                ok = poly is not None and cv2.isContourConvex(warp([[x, y0], [x + w, y0], [x + w, y0 + h], [x, y0 + h]], H)) and 1 / RULES['maxAreaChange'] < cv2.contourArea(poly) / ref_area < RULES['maxAreaChange']
                if not ok:
                    misses += 1
                    continue
                misses = 0
                track[t] = (poly, inl)
        times = sorted(track)
        p['track'] = track
        p['visible'] = [times[0], times[-1]]
        print(f"{p['parcel']}: on screen {times[0]:.1f}–{times[-1]:.1f} s ({len(times)} tracked frames)")
        full = [t for t in times if (track[t][0][:, 0].min() >= 2 and track[t][0][:, 0].max() < width - 2 and track[t][0][:, 1].min() >= 2 and track[t][0][:, 1].max() < height - 2 and cv2.contourArea(track[t][0]) >= RULES['minParcelPixels'])]
        chosen = [p['refT']]
        for t in sorted(full, key=lambda t: -cv2.contourArea(track[t][0])):
            if len(chosen) >= RULES['analysisFrames']:
                break
            if all(abs(t - c) >= RULES['analysisGapS'] for c in chosen):
                chosen.append(t)
        p['analysis'] = sorted(chosen)

    # ── 3. classifier: trained on rectangles of the SAME shot (same light, same height); tested frame against frame ──
    lo, hi = min(p['visible'][0] for p in parcels) - RULES['shotMarginS'], max(p['visible'][1] for p in parcels) + RULES['shotMarginS']
    samples = {}
    for r in P['training']:
        f = frame_at(cap, r['t'])
        x0, y0, x1, y1 = r['rect']
        feats = features(f)[y0:y1, x0:x1].reshape(-1, len(FEATURE_NAMES))
        pick = rng.choice(len(feats), size=min(RULES['samplesPerRect'], len(feats)), replace=False)
        samples.setdefault(r['t'], []).append((feats[pick], np.full(len(pick), CLASSES.index(LABEL_CLASS[r['label']])), r))
    in_shot = sorted(t for t in samples if lo <= t <= hi)
    other = sorted(t for t in samples if t not in in_shot)
    stack = lambda ts: (np.vstack([x for t in ts for x, _, _ in samples[t]]), np.concatenate([y for t in ts for _, y, _ in samples[t]]))
    fit = lambda X, y: RandomForestClassifier(n_estimators=RULES['trees'], min_samples_leaf=5, class_weight='balanced', random_state=7, n_jobs=-1).fit(X, y)
    tea = CLASSES.index('tea')

    def score(conf):
        return {'pixels': int(conf.sum()), 'accuracy': round(float(np.trace(conf) / max(conf.sum(), 1)), 3), 'teaRecall': round(float(conf[tea, tea] / max(conf[tea].sum(), 1)), 3), 'teaPrecision': round(float(conf[tea, tea] / max(conf[:, tea].sum(), 1)), 3), 'confusion': conf.tolist()}

    confusion = np.zeros((len(CLASSES), len(CLASSES)), int)
    reference = []
    for held in in_shot:
        m = fit(*stack([t for t in in_shot if t != held]))
        for X, y, r in samples[held]:
            pred = m.predict(X)
            for a, b in zip(y, pred):
                confusion[a, b] += 1
            reference.append({'t': held, 'label': r['label'], 'rect': r['rect'], 'teaShare': round(float(np.mean(pred == tea)), 3)})
    X, y = stack(in_shot)
    model = fit(X, y)
    transfer = np.zeros_like(confusion)
    if other:
        Xo, yo = stack(other)
        for a, b in zip(yo, model.predict(Xo)):
            transfer[a, b] += 1
    ref_tea = sorted(r['teaShare'] for r in reference if r['label'] == 'tea')
    ref_other = sorted(r['teaShare'] for r in reference if r['label'] in ('woody', 'low_other'))
    validation = {
        'method': 'Aynı çekimin kareleri arasında çapraz sınama (bir karede eğitilip diğerinde denendi). Eğitim dikdörtgenleri gözle işaretlendi; saha etiketi yok.',
        'classes': CLASSES,
        'frames': in_shot,
        **score(confusion),
        'trainingRectangles': {c: sum(1 for t in in_shot for _, _, r in samples[t] if LABEL_CLASS[r['label']] == c) for c in CLASSES},
        # Share of each reference rectangle called tea by the model trained on the other frame: what a "tea" and a
        # "not tea" area look like to the classifier, and so what a parcel share can mean.
        'referenceAreas': reference,
        'referenceTeaRange': [ref_tea[0], float(np.median(ref_tea)), ref_tea[-1]] if ref_tea else None,
        'referenceOtherRange': [ref_other[0], float(np.median(ref_other)), ref_other[-1]] if ref_other else None,
        'transfer': {'frames': other, **score(transfer), 'note': 'Aynı model videonun başka çekimlerindeki işaretli alanlarda: farklı ışık ve yükseklikte ne kadar tuttuğu.'} if other else None,
        'topFeatures': [{'feature': FEATURE_NAMES[i], 'importance': round(float(model.feature_importances_[i]), 3)} for i in np.argsort(-model.feature_importances_)[:6]],
    }
    print('in-shot cross-frame:', {k: validation[k] for k in ('accuracy', 'teaRecall', 'teaPrecision')}, 'tea refs', validation['referenceTeaRange'], 'other refs', validation['referenceOtherRange'])
    if other:
        print('transfer to other shots:', {k: validation['transfer'][k] for k in ('accuracy', 'teaRecall', 'teaPrecision')})

    # ── 4. per parcel: classify the analysed frames inside the outline ──
    results = []
    for p in parcels:
        slug = p['parcel'].replace('/', '-')
        frames = []
        for t in p['analysis']:
            f = frame_at(cap, t)
            poly = p['track'][t][0]
            mask = np.zeros((height, width), np.uint8)
            cv2.fillPoly(mask, [poly.astype(np.int32)], 255)
            mask = cv2.erode(mask, np.ones((5, 5), np.uint8))
            x, y0, w, h = cv2.boundingRect(poly.astype(np.int32))
            pad = int(max(w, h) * 0.45) + 20
            xa, ya, xb, yb = max(x - pad, 0), max(y0 - pad, 0), min(x + w + pad, width), min(y0 + h + pad, height)
            proba = model.predict_proba(features(f)[ya:yb, xa:xb].reshape(-1, len(FEATURE_NAMES))).reshape(yb - ya, xb - xa, -1)
            label = np.full(proba.shape[:2], -1, int)
            cols = model.classes_
            label[:] = cols[np.argmax(proba, axis=2)]
            label[np.max(proba, axis=2) < RULES['uncertainProbability']] = -1
            inside = mask[ya:yb, xa:xb] > 0
            total = int(inside.sum())
            shares = {c: round(float(np.sum(inside & (label == i)) / total), 3) for i, c in enumerate(CLASSES)}
            shares['uncertain'] = round(float(np.sum(inside & (label == -1)) / total), 3)
            # Sharpness inside the outline (variance of the Laplacian): compression and motion blur lower it.
            sharp = float(cv2.Laplacian(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), cv2.CV_64F)[mask > 0].var())
            crop = f[ya:yb, xa:xb].copy()
            tint = crop.copy()
            for i, c in enumerate(CLASSES):
                tint[label == i] = TINT[c]
            shown = cv2.addWeighted(crop, 0.55, tint, 0.45, 0)
            shown[~inside] = (crop[~inside] * 0.55).astype(np.uint8)
            local = (poly - [xa, ya]).astype(np.int32)
            scale = max(1.0, 560 / max(crop.shape[:2]))
            big = lambda im: cv2.resize(im, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            a, b = big(crop), big(shown)
            for im in (a, b):
                cv2.polylines(im, [(local * scale).astype(np.int32)], True, (0, 0, 255), 2)
            name = f'{slug}-{int(round(t * 10)):05d}'
            cv2.imwrite(os.path.join(out_dir, name + '-frame.jpg'), a, [cv2.IMWRITE_JPEG_QUALITY, 90])
            cv2.imwrite(os.path.join(out_dir, name + '-classes.jpg'), b, [cv2.IMWRITE_JPEG_QUALITY, 90])
            frames.append({'t': t, 'isReference': t == p['refT'], 'pixels': total, 'inliers': None if t == p['refT'] else int(p['track'][t][1]), 'sharpness': round(sharp, 1), 'shares': shares, 'frame': name + '-frame.jpg', 'classes': name + '-classes.jpg'})
        tea_shares = [fr['shares']['tea'] for fr in frames]
        median, spread = float(np.median(tea_shares)), float(max(tea_shares) - min(tea_shares))
        if len(frames) < 2 or spread > RULES['maxSpread']:
            cls = 'uncertain'
        elif median >= RULES['teaPresentShare']:
            cls = 'tea_present'
        elif median <= RULES['teaAbsentShare']:
            cls = 'tea_not_found'
        else:
            cls = 'partial'
        # Confidence is capped at "medium": one compressed video, labels by eye, no field check.
        margin = min(abs(median - RULES['teaPresentShare']), abs(median - RULES['teaAbsentShare']))
        confidence = 'low' if cls == 'uncertain' or len(frames) < 3 or margin < 0.08 else 'medium'
        # Full reference frame with the outline, for the record.
        ref = frame_at(cap, p['refT'])
        cv2.polylines(ref, [p['refPolygon'].astype(np.int32)], True, (0, 0, 255), 2)
        cv2.imwrite(os.path.join(out_dir, slug + '-reference.jpg'), ref, [cv2.IMWRITE_JPEG_QUALITY, 88])
        results.append({
            'parcel': p['parcel'], 'hypothesis': p['hypothesis'], 'class': cls, 'confidence': confidence,
            'teaShareMedian': round(median, 3), 'teaShareSpread': round(spread, 3),
            'otherShares': {c: round(float(np.median([fr['shares'][c] for fr in frames])), 3) for c in ['other_vegetation', 'built', 'uncertain']},
            'match': {'t': p['refT'], 'inliers': p['refInliers'], 'keypoints': p['stillKeypoints']},
            'visible': p['visible'], 'trackedFrames': len(p['track']), 'frames': frames,
            'outline': {'t': p['refT'], 'frame': [width, height], 'polygon': [[round(float(x), 1), round(float(yy), 1)] for x, yy in p['refPolygon']], 'reference': slug + '-reference.jpg', 'kind': 'hand_drawn'},
        })
        print(p['parcel'], cls, confidence, 'tea share median', round(median, 3), 'spread', round(spread, 3), [fr['shares'] for fr in frames])

    # ── what the video can support: resolution, sharpness, overlap between frames one second apart ──
    lo, hi = min(p['visible'][0] for p in parcels), max(p['visible'][1] for p in parcels)
    moves, sharp = [], []
    t = lo
    prev = None
    while t <= hi:
        f = frame_at(cap, t)
        if f is None:
            break
        d = describe(f)
        sharp.append(float(cv2.Laplacian(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()))
        if prev is not None:
            H, inl = homography(prev, d)
            if H is not None and inl >= RULES['minInliers']:
                c = warp([[width / 2, height / 2]], H)[0]
                moves.append(float(np.hypot(c[0] - width / 2, c[1] - height / 2)) / width)
        prev = d
        t += 1.0
    capture = {
        'width': width, 'height': height, 'fps': round(fps, 2), 'durationS': round(duration, 1),
        'bitrateMbps': round(os.path.getsize(video) * 8 / duration / 1e6, 2),
        'shot': [lo, hi],
        'sharpnessMedian': round(float(np.median(sharp)), 1),
        'shiftPerSecondShare': round(float(np.median(moves)), 3) if moves else None,
        'overlapAtOneSecond': round(1 - float(np.median(moves)), 3) if moves else None,
        'hasFlightLog': False, 'hasCameraCalibration': False, 'georeference': P['source']['georeference'],
    }
    print('capture', capture)
    json.dump({'project': {k: P[k] for k in ('id', 'title', 'province', 'district', 'neighborhood', 'capturedAt', 'capturedAtNote', 'source', 'trainingNote')}, 'rules': RULES, 'capture': capture, 'validation': validation, 'parcels': results}, open(os.path.join(out_dir, 'analysis.json'), 'w', encoding='utf8'), ensure_ascii=False)
    print('written', os.path.join(out_dir, 'analysis.json'))


if __name__ == '__main__':
    main()
