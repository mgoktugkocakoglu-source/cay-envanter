"""Land cover of every parcel with the model the comparison chose: tea or not, and what else grows there.

  .venv/Scripts/python.exe py/cover_classify.py data/library/<province>/<district>/<neighbourhood>

Input : land-cover/samples.csv, pixels.csv (npm run sample-cover), experiments.json (py/cover_experiments.py), parcels.ndjson
Output: land-cover/cover.json — per parcel the share of each cover class, the tea reading and the model's measured numbers.

The model is the one the experiments measured (same features, same learner), trained on all labelled pixels. A parcel
is read from the pixels whose centre falls inside it; the shares are pixel counts, not surveyed areas.
"""
import csv
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from cover_experiments import CLASSES, RULES as EXPERIMENT_RULES, learners  # noqa: E402

RULES = {
    # Same reading bands as the licence audit, so the two modules can be set side by side.
    'teaPresentShare': 0.3,
    'teaAbsentShare': 0.1,
    # Below this many pixel centres the 10 m grid cannot describe the parcel.
    'minPixels': 3,
    'fewPixels': 6,
    # A cover is named for the parcel when it holds at least this share; otherwise the parcel is "mixed".
    'dominantShare': 0.5,
}
LABELS = {'tea': 'Çay', 'hazelnut': 'Fındık', 'forest': 'Orman / ağaçlık', 'grass': 'Çayır / otluk', 'crop': 'Ekili alan', 'built': 'Yapı', 'other': 'Çıplak zemin / su', 'mixed': 'Karışık'}


def main():
    root = sys.argv[1]
    cover_dir = os.path.join(root, 'land-cover')
    experiments = json.load(open(os.path.join(cover_dir, 'experiments.json'), encoding='utf8'))
    chosen = experiments['bestCover']
    bands = experiments['featureSets'][chosen['features']]

    rows = [r for r in csv.DictReader(open(os.path.join(cover_dir, 'samples.csv'), encoding='utf8')) if r['cls'] in CLASSES and all(r[b] != '' for b in bands)]
    X = np.array([[float(r[b]) for b in bands] for r in rows], np.float32)
    y = np.array([CLASSES.index(r['cls']) for r in rows])
    model = learners()[chosen['learner']]().fit(X, y)
    importance = getattr(model, 'feature_importances_', None)

    pixels = [r for r in csv.DictReader(open(os.path.join(cover_dir, 'pixels.csv'), encoding='utf8')) if all(r[b] != '' for b in bands)]
    P = model.predict_proba(np.array([[float(r[b]) for b in bands] for r in pixels], np.float32))
    full = np.zeros((len(pixels), len(CLASSES)))
    full[:, model.classes_] = P
    by_key = {}
    for i, r in enumerate(pixels):
        by_key.setdefault(r['key'], []).append(i)
    max_tea_elevation = max((float(r['elevation']) for r in rows if r['cls'] == 'tea' and r['elevation'] != ''), default=None)

    tea = CLASSES.index('tea')
    parcels = []
    for line in open(os.path.join(root, 'parcels.ndjson'), encoding='utf8'):
        if not line.strip():
            continue
        p = json.loads(line)['properties']
        idx = by_key.get(p['key'], [])
        base = {'key': p['key'], 'block': p['block'], 'parcel': p['parcel'], 'nature': p['nature'], 'locality': p.get('locality', ''), 'areaM2': round(p['geometryAreaM2']), 'pixels': len(idx)}
        if len(idx) < RULES['minPixels']:
            parcels.append({**base, 'tea': 'not_assessable', 'teaShare': None, 'teaProbability': None, 'dominant': None, 'dominantShare': None, 'shares': None, 'confidence': None, 'beyondTraining': False})
            continue
        probs = full[idx]
        hard = probs.argmax(axis=1)
        shares = {c: round(float((hard == i).mean()), 3) for i, c in enumerate(CLASSES)}
        tea_share = shares['tea']
        top = max(shares, key=shares.get)
        elevation = float(np.mean([float(pixels[i]['elevation']) for i in idx if pixels[i]['elevation'] != ''] or [0]))
        state = 'present' if tea_share >= RULES['teaPresentShare'] else 'absent' if tea_share < RULES['teaAbsentShare'] else 'partial'
        # How sure the pixels themselves are: mean probability of the class each pixel was given.
        certainty = float(probs.max(axis=1).mean())
        confidence = 'low' if len(idx) < RULES['fewPixels'] or certainty < 0.6 else 'high' if certainty >= 0.8 and (tea_share >= 0.6 or tea_share < 0.05) else 'medium'
        parcels.append({
            **base, 'tea': state, 'teaShare': tea_share, 'teaProbability': round(float(probs[:, tea].mean()), 3),
            'dominant': top if shares[top] >= RULES['dominantShare'] else 'mixed', 'dominantShare': shares[top], 'shares': shares,
            'confidence': confidence, 'elevationM': round(elevation), 'beyondTraining': max_tea_elevation is not None and elevation > max_tea_elevation,
        })

    assessed = [p for p in parcels if p['tea'] != 'not_assessable']
    count = lambda key, values: {v: sum(1 for p in parcels if p[key] == v) for v in values}
    result = next(r for r in experiments['results'] if r['features'] == chosen['features'] and r['learner'] == chosen['learner'] and r['target'] == 'cover')
    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'method': 'Her parselin 10 m pikselleri, optik ve radar özniteliklerinden eğitilmiş bir sınıflandırıcıyla arazi örtüsü sınıflarına ayrılır; parselin çay durumu ve baskın örtüsü piksel paylarından okunur. Model, tapu niteliği ve konum bilgisi kullanmaz. Ön değerlendirmedir.',
        'rules': RULES, 'classes': CLASSES, 'labels': LABELS,
        'model': {
            'features': chosen['features'], 'learner': chosen['learner'], 'bands': len(bands), 'bandNames': bands,
            'trainingPixels': experiments['pixels'], 'trainingGroups': experiments['groups'],
            'crossValidation': {k: result[k] for k in ('accuracy', 'teaAccuracy', 'teaRecall', 'teaPrecision', 'teaF1')},
            'confusion': chosen['confusion'], 'teaThresholds': chosen['teaThresholds'], 'calledTeaByClass': chosen['calledTeaByClass'],
            # Held-out titled parcels read as a whole, at the share the parcel reading uses for "present".
            'parcelLevel': chosen.get('parcelLevel', {}).get(str(RULES['teaPresentShare'])),
            'comparison': experiments['results'], 'folds': EXPERIMENT_RULES['folds'],
            'topFeatures': [{'band': bands[i], 'importance': round(float(importance[i]), 4)} for i in np.argsort(-importance)[:12]] if importance is not None else [],
            'maxTrainingTeaElevationM': max_tea_elevation, 'validationNote': experiments['method'],
        },
        'summary': {
            'parcels': len(parcels), 'assessed': len(assessed),
            'byTea': count('tea', ['present', 'partial', 'absent', 'not_assessable']),
            'byDominant': count('dominant', CLASSES + ['mixed']),
            'byConfidence': count('confidence', ['high', 'medium', 'low']),
            'teaAreaM2': round(sum(p['teaShare'] * p['areaM2'] for p in assessed)),
        },
        'parcels': parcels,
    }
    json.dump(out, open(os.path.join(cover_dir, 'cover.json'), 'w', encoding='utf8'), ensure_ascii=False)
    print('parcels', len(parcels), 'assessed', len(assessed), out['summary']['byTea'], out['summary']['byDominant'], out['summary']['byConfidence'])


if __name__ == '__main__':
    main()
