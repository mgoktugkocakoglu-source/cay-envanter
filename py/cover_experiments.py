"""Which data reads tea best: every feature family and learner on the same labelled pixels, tested parcel against parcel.

  .venv/Scripts/python.exe py/cover_experiments.py data/library/<province>/<district>/<neighbourhood>

Input: land-cover/samples.csv (npm run sample-cover). Output: land-cover/experiments.json.

How it is measured
  - Grouped 5-fold cross-validation: all pixels of a parcel are in the same fold, so a model is never tested on a
    parcel it has seen (neighbouring pixels of one garden are near copies). Map-labelled pixels are grouped by a
    300 m block for the same reason.
  - Every variant gets the same folds. Reported per variant: overall accuracy over all cover classes, and for tea
    alone recall, precision and F1 (tea against everything else), each as the mean and the spread over folds.
  - Labels are deed titles and a global land-cover map, not field visits: the numbers measure agreement with those.
"""
import csv
import json
import math
import os
import sys

import numpy as np
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.model_selection import GroupKFold

RULES = {
    'folds': 5,
    'trees': 300,
    'blockM': 300,
    'seed': 7,
    # The ten bands the audit detector leaned on most (its importance list).
    'top10': ['B12_sum', 'B11_sum', 'B5_sum', 'NDVI_p50', 'B2_sum', 'evergreen', 'B11_aut', 'B12_aut', 'NDVI_p10', 'NDMI_off'],
}
CLASSES = ['tea', 'hazelnut', 'forest', 'grass', 'crop', 'built', 'other']


def family(band):
    if band.startswith(('VV', 'VH')):
        return 'radar'
    if band.startswith('NDVI') or band == 'evergreen':
        return 'ndvi'
    return 'optical'


def load(path):
    rows = list(csv.DictReader(open(path, encoding='utf8')))
    meta = {'cls', 'grp', 'nbh', 'elevation', 'lon', 'lat', 'system:index', '.geo'}
    bands = [c for c in rows[0] if c not in meta]
    keep = [r for r in rows if r['cls'] in CLASSES and all(r[b] not in ('', None) for b in bands)]
    X = np.array([[float(r[b]) for b in bands] for r in keep], np.float32)
    y = np.array([CLASSES.index(r['cls']) for r in keep])
    lat0 = float(np.mean([float(r['lat']) for r in keep]))
    block = lambda r: 'b%d_%d' % (float(r['lon']) * 111320 * math.cos(math.radians(lat0)) // RULES['blockM'], float(r['lat']) * 110540 // RULES['blockM'])
    groups = np.array([r['grp'] if r['grp'] != 'map' else block(r) for r in keep])
    return bands, X, y, groups, len(rows) - len(keep)


def learners():
    seed = RULES['seed']
    return {
        'rf': lambda: RandomForestClassifier(n_estimators=RULES['trees'], min_samples_leaf=2, class_weight='balanced', random_state=seed, n_jobs=-1),
        'extra_trees': lambda: ExtraTreesClassifier(n_estimators=RULES['trees'], min_samples_leaf=2, class_weight='balanced', random_state=seed, n_jobs=-1),
        'boosting': lambda: HistGradientBoostingClassifier(max_iter=300, learning_rate=0.08, class_weight='balanced', random_state=seed),
    }


def feature_sets(bands):
    of = lambda *fams: [b for b in bands if family(b) in fams]
    sets = {
        'ndvi': of('ndvi'),
        'top10': [b for b in RULES['top10'] if b in bands],
        'optical': of('optical', 'ndvi'),
        'radar': of('radar'),
        'top10_radar': [b for b in RULES['top10'] if b in bands] + of('radar'),
        'ndvi_radar': of('ndvi', 'radar'),
        'all': list(bands),
    }
    return {k: v for k, v in sets.items() if v}


def evaluate(make, X, y, groups, binary=False):
    tea = CLASSES.index('tea')
    target = (y == tea).astype(int) if binary else y
    folds, proba_tea, pred_all = [], np.zeros(len(y)), np.zeros(len(y), int)
    for train, test in GroupKFold(n_splits=RULES['folds']).split(X, target, groups):
        model = make().fit(X[train], target[train])
        p = model.predict_proba(X[test])
        pred = model.classes_[np.argmax(p, axis=1)]
        pos = list(model.classes_).index(1 if binary else tea)
        proba_tea[test] = p[:, pos]
        pred_all[test] = pred
        is_tea, said = y[test] == tea, pred == (1 if binary else tea)
        tp, fp, fn = int((is_tea & said).sum()), int((~is_tea & said).sum()), int((is_tea & ~said).sum())
        recall, precision = tp / max(tp + fn, 1), tp / max(tp + fp, 1)
        folds.append({'accuracy': float((pred == target[test]).mean()), 'teaAccuracy': float((is_tea == said).mean()), 'teaRecall': recall, 'teaPrecision': precision, 'teaF1': 2 * recall * precision / max(recall + precision, 1e-9)})
    stat = lambda k: {'mean': round(float(np.mean([f[k] for f in folds])), 4), 'sd': round(float(np.std([f[k] for f in folds])), 4)}
    return {k: stat(k) for k in folds[0]}, proba_tea, pred_all


def main():
    root = sys.argv[1]
    bands, X, y, groups, dropped = load(os.path.join(root, 'land-cover', 'samples.csv'))
    counts = {c: int((y == i).sum()) for i, c in enumerate(CLASSES)}
    print('pixels', len(y), counts, '· groups', len(set(groups)), '· dropped (missing band)', dropped)
    sets = feature_sets(bands)
    L = learners()
    results = []
    out_path = os.path.join(root, 'land-cover', 'experiments.json')
    # --detail: keep the measured comparison, redo only the detail of the chosen model.
    detail_only = '--detail' in sys.argv and os.path.exists(out_path)
    if detail_only:
        results = json.load(open(out_path, encoding='utf8'))['results']
    # 1. feature families with the reference learner, all cover classes at once and tea-vs-rest
    for name, cols in ({} if detail_only else sets).items():
        idx = [bands.index(b) for b in cols]
        for mode in ('cover', 'tea_only'):
            metrics, _, _ = evaluate(L['rf'], X[:, idx], y, groups, binary=mode == 'tea_only')
            results.append({'features': name, 'bands': len(cols), 'learner': 'rf', 'target': mode, **metrics})
            print('%-12s %-9s %2d bands  acc %.3f  tea: acc %.3f recall %.3f precision %.3f F1 %.3f ±%.3f' % (name, mode, len(cols), metrics['accuracy']['mean'], metrics['teaAccuracy']['mean'], metrics['teaRecall']['mean'], metrics['teaPrecision']['mean'], metrics['teaF1']['mean'], metrics['teaF1']['sd']))
    # 2. the other learners on the two best feature sets
    ranked = sorted([r for r in results if r['target'] == 'cover'], key=lambda r: -r['teaF1']['mean'])
    for name in ([] if detail_only else [r['features'] for r in ranked[:2]]):
        idx = [bands.index(b) for b in sets[name]]
        for learner in ('extra_trees', 'boosting'):
            for mode in ('cover', 'tea_only'):
                metrics, _, _ = evaluate(L[learner], X[:, idx], y, groups, binary=mode == 'tea_only')
                results.append({'features': name, 'bands': len(sets[name]), 'learner': learner, 'target': mode, **metrics})
                print('%-12s %-9s %-11s acc %.3f  tea: acc %.3f recall %.3f precision %.3f F1 %.3f ±%.3f' % (name, mode, learner, metrics['accuracy']['mean'], metrics['teaAccuracy']['mean'], metrics['teaRecall']['mean'], metrics['teaPrecision']['mean'], metrics['teaF1']['mean'], metrics['teaF1']['sd']))
    best = max(results, key=lambda r: (r['teaF1']['mean'], r['target'] == 'cover'))
    # 3. the chosen variant in detail: confusion over cover classes, tea threshold sweep, per-class recall
    idx = [bands.index(b) for b in sets[best['features']]]
    cover_best = max([r for r in results if r['target'] == 'cover'], key=lambda r: r['teaF1']['mean'])
    cidx = [bands.index(b) for b in sets[cover_best['features']]]
    _, proba, pred = evaluate(L[cover_best['learner']], X[:, cidx], y, groups)
    confusion = [[int(((y == a) & (pred == b)).sum()) for b in range(len(CLASSES))] for a in range(len(CLASSES))]
    tea = CLASSES.index('tea')
    sweep = []
    for t in (0.3, 0.4, 0.5, 0.6, 0.7):
        said, is_tea = proba >= t, y == tea
        tp, fp, fn = int((said & is_tea).sum()), int((said & ~is_tea).sum()), int((~said & is_tea).sum())
        sweep.append({'threshold': t, 'recall': round(tp / max(tp + fn, 1), 4), 'precision': round(tp / max(tp + fp, 1), 4)})
    # Parcel level: what the module is used for. Each titled parcel is read from its held-out pixels alone
    # (it was in the test fold when they were predicted) with the same share bands the parcel reading uses.
    parcel_level = {}
    for present_share in (0.3, 0.5):
        rows = []
        for g in sorted(set(groups)):
            m = groups == g
            if g.startswith('b') and '_' in g and '/' not in g or m.sum() < 3:
                continue
            rows.append((CLASSES[int(np.bincount(y[m]).argmax())], float((pred[m] == tea).mean())))
        teas = [share for cls, share in rows if cls == 'tea']
        others = [share for cls, share in rows if cls != 'tea']
        tp, fn = sum(s >= present_share for s in teas), sum(s < present_share for s in teas)
        fp, tn = sum(s >= present_share for s in others), sum(s < present_share for s in others)
        by_class = {c: {'parcels': sum(1 for cls, _ in rows if cls == c), 'calledTea': sum(1 for cls, share in rows if cls == c and share >= present_share)} for c in CLASSES if any(cls == c for cls, _ in rows)}
        parcel_level[str(present_share)] = {'teaParcels': len(teas), 'otherParcels': len(others), 'teaFound': tp, 'teaMissed': fn, 'otherCalledTea': fp, 'otherRight': tn,
                                           'accuracy': round((tp + tn) / max(len(rows), 1), 4), 'teaRecall': round(tp / max(tp + fn, 1), 4), 'teaPrecision': round(tp / max(tp + fp, 1), 4), 'byClass': by_class}
    print('parcel level:', json.dumps(parcel_level))
    called_tea = {c: round(float((pred[y == i] == tea).mean()), 4) if (y == i).any() else None for i, c in enumerate(CLASSES)}
    out = {
        'rules': RULES, 'classes': CLASSES, 'pixels': counts, 'groups': len(set(groups)), 'droppedPixels': dropped, 'bands': bands,
        'featureSets': {k: v for k, v in sets.items()}, 'results': results,
        'best': {'features': best['features'], 'learner': best['learner'], 'target': best['target']},
        'bestCover': {'features': cover_best['features'], 'learner': cover_best['learner'], 'confusion': confusion, 'teaThresholds': sweep, 'calledTeaByClass': called_tea, 'parcelLevel': parcel_level},
        'method': 'Parsel bazlı 5 katlı çapraz sınama: bir parselin bütün pikselleri aynı katta; model hiç görmediği parsellerde sınanır. Etiketler tapu niteliği ve küresel arazi örtüsü haritasıdır, saha verisi değildir.',
    }
    json.dump(out, open(out_path, 'w', encoding='utf8'), ensure_ascii=False)
    print('best for tea:', out['best'], '· best cover model:', cover_best['features'], cover_best['learner'])
    print('called tea by true class:', called_tea)
    print('threshold sweep:', sweep)


if __name__ == '__main__':
    main()
