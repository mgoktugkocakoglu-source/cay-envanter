"""Land cover of every parcel, read from the ground's own behaviour instead of the deed title (method v2).

  .venv/Scripts/python.exe py/cover_classify.py data/library/<province>/<district>/<neighbourhood>

Input : land-cover/samples.csv, pixels.csv and their -extra.csv (npm run sample-cover), reference.json
        (py/cover_reference.py), parcels.ndjson; optional groups.json (py/cover_groups.py), experiments.json
        (py/cover_experiments.py, the earlier title-trained study), field-samples.csv (areas marked on the site).
Output: land-cover/cover.json — per parcel the tea reading, the share of each cover class, the canopy and winter
        evidence, and a model card with every method scored on the independent reference parcels.

Why v2. A model trained on deed titles learns the titles: tea gardens that have grown over with trees still read
"Çay Bahçesi", so tree canopy is learnt as tea. Scored on parcels a person actually looked at, the title-trained
model was right about half the time, whatever features it was given. This step therefore takes its training labels
from two physical facts that do not depend on any title:
  - canopy height (Meta / WRI 1 m map): tea is a shrub of about a metre, trees stand well above;
  - winter greenness (Sentinel-2, leaf-off NDVI as a share of summer NDVI): tea keeps its leaves, hazelnut,
    broadleaf trees and meadows do not. It is read from the snow-masked median of November-March, never from the
    plain mean of the winter months: above about 800 m the ground lies under snow in mid-winter, and an average of
    December-February then reads evergreen tea as leafless (a field-confirmed tea parcel at 1 200 m came out 2 % tea).
Pixels where both agree clearly get a label ("consensus"); a classifier on current Sentinel-2 data learns from them
and decides the rest. Canopy height is not an input of that classifier: the height map is several years old, the
Sentinel-2 composites are current, so the model can follow what has changed since.

Classes are what these facts can tell apart: tea, tree cover, open seasonal cover, built / bare. Hazelnut and forest are
both "tree cover": neither source separates them reliably here, and no published Sentinel study does.
"""
import csv
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import GroupKFold

CLASSES = ['tea', 'trees', 'open', 'built']
LABELS = {'tea': 'Çay', 'trees': 'Ağaç örtüsü (orman, fındık, ağaçlanmış bahçe)', 'open': 'Açık alan (çayır, ekili alan, mevsimlik örtü)', 'built': 'Yapı / çıplak zemin', 'mixed': 'Karışık'}
# What a person can mark on the site, and the physical class it trains.
MARKED = {'tea': 'tea', 'hazelnut': 'trees', 'forest': 'trees', 'grass': 'open', 'crop': 'open', 'built': 'built', 'other': 'built'}
TITLE_CLASSES = ['tea', 'hazelnut', 'forest', 'grass', 'crop', 'built', 'other']
META = {'key', 'cls', 'grp', 'nbh', 'elevation', 'lon', 'lat'}

RULES = {
    # ── consensus labels: a pixel is labelled only where canopy height and winter greenness agree clearly ──
    # Tea: no trees over it, leaf-off NDVI (snow masked) at least this share of summer NDVI, and a dense canopy all year.
    'teaMaxTallShare': 0.1,
    'teaMinWinterRatio': 0.90,
    'teaMinNdvi': 0.70,
    # Tree cover: at least this share of the pixel under canopy of 3 m or more.
    'treesMinTallShare': 0.7,
    # Open seasonal cover: no trees, loses much of its greenness in winter, but is vegetated.
    'openMaxWinterRatio': 0.72,
    'openMinNdvi': 0.55,
    # Hardly any vegetation in the median of the year.
    'builtMaxNdvi': 0.40,
    # ── the plain physical rule, kept as the transparent yardstick beside the model ──
    'ruleWinterRatio': 0.86,
    'ruleMaxTallShare': 0.3,
    'ruleMinNdvi': 0.62,
    # ── high ground ──
    # On parcels at this mean elevation and up, a pixel the model does not read as tea still counts as tea when it has
    # no trees over it, is densely vegetated and keeps this share of its summer NDVI in the leaf-off window. Snow and
    # the few clear winter scenes pull the ratio of real tea below the 0.86 of the plain rule there, and the training
    # labels hold little tea that high. Measured on the reference (18 Nov 2026): tea found at 800 m and up 7 -> 10 of
    # 13, below 800 m unchanged, no-tea 41/48 unchanged. No "no tea" reference parcel exists above 800 m, so false
    # alarms up there are not measured: promoted parcels carry the flag high_altitude_rule and never read "high".
    'highElevationM': 800,
    'highWinterRatio': 0.82,
    # ── parcel reading ──
    'teaPresentShare': 0.5,
    'teaAbsentShare': 0.1,
    'minPixels': 3,
    'fewPixels': 6,
    'dominantShare': 0.5,
    # A "no tea" drone reading is called disputed when both physical facts say open evergreen cover on the parcel.
    'disputedMaxTallShare': 0.3,
    'disputedMinWinterRatio': 0.82,
    # Weight of a pixel inside an area a person marked on the site, against a consensus-labelled pixel.
    'markedWeight': 5.0,
    'seed': 7,
}


def read(cover_dir, name):
    path = os.path.join(cover_dir, name + '.csv')
    if not os.path.exists(path):
        return []
    rows = list(csv.DictReader(open(path, encoding='utf8')))
    extra = os.path.join(cover_dir, name + '-extra.csv')
    if not os.path.exists(extra):
        raise SystemExit(f'{name}-extra.csv yok: önce "npm run sample-cover -- ... --only extra" çalıştırın.')
    extras = list(csv.DictReader(open(extra, encoding='utf8')))
    if len(extras) != len(rows):
        raise SystemExit(f'{name}-extra.csv satır sayısı {name}.csv ile uyuşmuyor; --only extra yeniden çalıştırılmalı.')
    for r, e in zip(rows, extras):
        r.update(e)
    return rows


def family(band):
    if band.startswith('CH_') or band == 'GH':
        return 'height'
    if band.startswith('DW_'):
        return 'dw'
    if len(band) == 3 and band[0] == 'A' and band[1:].isdigit():
        return 'embedding'
    if band.startswith(('VV', 'VH')):
        return 'radar'
    return 'optical'


def make():
    return HistGradientBoostingClassifier(max_iter=300, learning_rate=0.08, class_weight='balanced', random_state=RULES['seed'])


def main():
    root = sys.argv[1]
    cover_dir = os.path.join(root, 'land-cover')
    R = RULES
    S, P, F = read(cover_dir, 'samples'), read(cover_dir, 'pixels'), read(cover_dir, 'field-samples')
    bands = [c for c in P[0] if c not in META]
    num = lambda r, b: float(r[b]) if r.get(b) not in ('', None) else np.nan
    matrix = lambda rows: np.array([[num(r, b) for b in bands] for r in rows], np.float32)
    XS, XP = matrix(S), matrix(P)
    key_p = np.array([r['key'] for r in P])
    grp_s = np.array([r['grp'] for r in S])
    col = lambda b: bands.index(b)
    of = lambda *fams: [i for i, b in enumerate(bands) if family(b) in fams]
    optical = of('optical')

    def evidence(X):
        # `evergreen` = median NDVI of the snow-masked leaf-off window (Nov-Mar) over the summer median (src/audit/tea-evidence.ts).
        return {'ratio': X[:, col('evergreen')], 'ndvi': X[:, col('NDVI_p50')], 'tall': X[:, col('CH_tall')], 'height': X[:, col('CH_mean')]}

    def consensus(e):
        """-1 where the two facts do not agree clearly enough to label the pixel."""
        y = np.full(len(e['ndvi']), -1)
        y[(e['tall'] <= R['teaMaxTallShare']) & (e['ratio'] >= R['teaMinWinterRatio']) & (e['ndvi'] >= R['teaMinNdvi'])] = CLASSES.index('tea')
        y[e['tall'] >= R['treesMinTallShare']] = CLASSES.index('trees')
        y[(e['tall'] <= R['teaMaxTallShare']) & (e['ratio'] < R['openMaxWinterRatio']) & (e['ndvi'] >= R['openMinNdvi'])] = CLASSES.index('open')
        y[e['ndvi'] < R['builtMaxNdvi']] = CLASSES.index('built')
        return y

    eS, eP = evidence(XS), evidence(XP)
    yS, yP = consensus(eS), consensus(eP)
    rule_p = (eP['ratio'] >= R['ruleWinterRatio']) & (eP['tall'] < R['ruleMaxTallShare']) & (eP['ndvi'] >= R['ruleMinNdvi'])
    tea = CLASSES.index('tea')
    elevation_p = np.array([num(r, 'elevation') for r in P])
    parcel_elevation = {k: float(np.nanmean(elevation_p[key_p == k])) for k in set(key_p)}
    high_rule_p = np.array([parcel_elevation[k] >= R['highElevationM'] for k in key_p]) & (eP['ratio'] >= R['highWinterRatio']) & (eP['tall'] < R['ruleMaxTallShare']) & (eP['ndvi'] >= R['ruleMinNdvi'])

    # ── independent reference parcels ──
    reference = json.load(open(os.path.join(cover_dir, 'reference.json'), encoding='utf8'))['parcels'] if os.path.exists(os.path.join(cover_dir, 'reference.json')) else []
    ref = {r['key']: r for r in reference if (key_p == r['key']).sum() >= R['minPixels']}
    disputed = sorted(r['parcel'] for k, r in ref.items() if not r['tea'] and np.nanmean(eP['tall'][key_p == k]) < R['disputedMaxTallShare'] and np.nanmean(eP['ratio'][key_p == k]) >= R['disputedMinWinterRatio'])
    in_ref_p = np.array([k in ref for k in key_p])
    in_ref_s = np.array([g in ref for g in grp_s])

    def score(pixel_is_tea):
        def count(skip):
            tp = fn = fp = tn = 0
            for k, r in ref.items():
                if r['parcel'] in skip:
                    continue
                said = pixel_is_tea[key_p == k].mean() >= R['teaPresentShare']
                tp, fn, fp, tn = tp + (r['tea'] and said), fn + (r['tea'] and not said), fp + (not r['tea'] and said), tn + (not r['tea'] and not said)
            return {'teaFound': int(tp), 'teaTotal': int(tp + fn), 'noTeaRight': int(tn), 'noTeaTotal': int(tn + fp), 'accuracy': round((tp + tn) / max(tp + fn + fp + tn, 1), 4),
                    'balanced': round((tp / max(tp + fn, 1) + tn / max(tn + fp, 1)) / 2, 4)}
        return {**count(set()), 'undisputed': count(set(disputed))}

    comparison = []
    held_out = {}  # pixel readings of each method with the reference parcels kept out of its training

    def add(key, label, description, pixel_is_tea):
        row = {'key': key, 'label': label, 'description': description, **score(pixel_is_tea)}
        comparison.append(row)
        held_out[key] = pixel_is_tea
        print('%-22s tea %2d/%2d  no-tea %2d/%2d  balanced %.3f  (undisputed %.3f)' % (key, row['teaFound'], row['teaTotal'], row['noTeaRight'], row['noTeaTotal'], row['balanced'], row['undisputed']['balanced']))

    if ref:
        # 1. the earlier way: deed titles as labels, reference parcels kept out of the training
        title_y = np.array([TITLE_CLASSES.index(r['cls']) for r in S])
        for key, label, description, cols in (
            ('title_optical_radar', 'Tapu etiketi · optik + radar', 'Önceki yöntem: tapu niteliği etiket alınır, Sentinel-2 ve Sentinel-1 öznitelikleriyle eğitilir.', of('optical', 'radar')),
            ('title_everything', 'Tapu etiketi · bütün veriler', 'Aynı tapu etiketleri; ağaç yüksekliği, Dynamic World ve uydu gömme vektörleri de girdi olarak eklenir.', list(range(len(bands)))),
        ):
            m = make().fit(XS[~in_ref_s][:, cols], title_y[~in_ref_s])
            add(key, label, description, m.classes_[np.argmax(m.predict_proba(XP[:, cols]), axis=1)] == TITLE_CLASSES.index('tea'))
        # 2. the physical facts alone
        add('rule_winter', 'Kural · yalnız kış yeşilliği', f'Eğitim yok: kar maskeli kış NDVI\'si yazın en az %{round(R["ruleWinterRatio"] * 100)}\'i ve yıl boyu yoğun örtü.', (eP['ratio'] >= R['ruleWinterRatio']) & (eP['ndvi'] >= R['ruleMinNdvi']))
        add('rule_height', 'Kural · yalnız ağaç yüksekliği', 'Eğitim yok: üzerinde ağaç yok ve yoğun yeşil örtü var.', (eP['tall'] < R['ruleMaxTallShare']) & (eP['ndvi'] >= R['ruleMinNdvi']))
        add('rule_both', 'Kural · kış yeşilliği + ağaç yüksekliği', 'Eğitim yok: iki fiziksel ölçüt birlikte.', rule_p)
        # 3. consensus-labelled training, reference parcels kept out
        X_all, y_all = np.vstack([XS[~in_ref_s], XP[~in_ref_p]]), np.concatenate([yS[~in_ref_s], yP[~in_ref_p]])
        for key, label, description, cols in (
            ('consensus_embedding', 'Uzlaşı etiketi · gömme vektörleri', 'Etiketler iki fiziksel ölçütün uzlaştığı piksellerden; girdi Google uydu gömme vektörleri.', of('embedding')),
            ('consensus_optical', 'Uzlaşı etiketi · Sentinel-2', 'Etiketler iki fiziksel ölçütün uzlaştığı piksellerden; girdi güncel Sentinel-2 öznitelikleri. Ağaç yüksekliği girdi değildir.', optical),
        ):
            m = make().fit(X_all[y_all >= 0][:, cols], y_all[y_all >= 0])
            add(key, label, description, m.classes_[np.argmax(m.predict_proba(XP[:, cols]), axis=1)] == tea)
        add('consensus_optical_high', 'Uzlaşı etiketi · Sentinel-2 + yüksek rakım kuralı (kullanılan)',
            f'Aynı model; {R["highElevationM"]} m ve üzerindeki parsellerde ağaçsız, yoğun ve kışın yeşilliğinin en az %{round(R["highWinterRatio"] * 100)}\'ini koruyan pikseller de çay sayılır.',
            held_out['consensus_optical'] | high_rule_p)

    # ── areas a person marked on the site: scored, then added to the training ──
    field = None
    X_train, y_train = np.vstack([XS, XP]), np.concatenate([yS, yP])
    weights = np.ones(len(y_train))
    if F:
        usable = [r for r in F if r['cls'] in MARKED]
        XF = matrix(usable)
        yF = np.array([CLASSES.index(MARKED[r['cls']]) for r in usable])
        gF = np.array([r['grp'] for r in usable])

        def marked_score(pred):
            is_tea, said = yF == tea, pred == tea
            tp, fp, fn = int((is_tea & said).sum()), int((~is_tea & said).sum()), int((is_tea & ~said).sum())
            areas = sorted(set(gF))
            ok = sum(1 for a in areas if ((pred[gF == a] == tea).mean() >= R['teaPresentShare']) == (yF[gF == a][0] == tea))
            return {'teaAccuracy': round(float((is_tea == said).mean()), 4), 'coverAccuracy': round(float((pred == yF).mean()), 4), 'teaRecall': round(tp / max(tp + fn, 1), 4), 'teaPrecision': round(tp / max(tp + fp, 1), 4),
                    'areaAccuracy': round(ok / len(areas), 4), 'calledTeaByClass': {c: round(float((pred[np.array([r['cls'] == c for r in usable])] == tea).mean()), 4) for c in sorted({r['cls'] for r in usable})}}

        field = {'areas': len(set(gF)), 'pixels': len(usable), 'byClass': {c: {'areas': len({r['grp'] for r in usable if r['cls'] == c}), 'pixels': sum(1 for r in usable if r['cls'] == c)} for c in sorted({r['cls'] for r in usable})},
                 'asIs': None, 'calibrated': None, 'note': None}
        if (yF == tea).any() and (yF != tea).any():
            base = make().fit(X_train[y_train >= 0][:, optical], y_train[y_train >= 0])
            field['asIs'] = marked_score(base.classes_[np.argmax(base.predict_proba(XF[:, optical]), axis=1)])
            folds = min(5, len(set(gF)))
            if folds >= 3:
                pred = np.zeros(len(yF), int)
                for tr, te in GroupKFold(n_splits=folds).split(XF, yF, gF):
                    m = make().fit(np.vstack([X_train[y_train >= 0][:, optical], XF[tr][:, optical]]), np.concatenate([y_train[y_train >= 0], yF[tr]]), sample_weight=np.concatenate([np.ones(int((y_train >= 0).sum())), np.full(len(tr), R['markedWeight'])]))
                    pred[te] = m.classes_[np.argmax(m.predict_proba(XF[te][:, optical]), axis=1)]
                field['calibrated'] = marked_score(pred)
            else:
                field['note'] = 'Kalibrasyonlu ölçüm için en az üç işaretli alan gerekir.'
        else:
            field['note'] = 'Ölçüm için hem çay hem çay olmayan işaretli alan gerekir.'
        X_train, y_train, weights = np.vstack([X_train, XF]), np.concatenate([y_train, yF]), np.concatenate([weights, np.full(len(yF), R['markedWeight'])])
        print('marked areas:', json.dumps(field))

    # ── the model the parcels are read with: every consensus pixel (and every marked pixel) ──
    labelled = y_train >= 0
    model = make().fit(X_train[labelled][:, optical], y_train[labelled], sample_weight=weights[labelled])
    proba = np.zeros((len(P), len(CLASSES)))
    proba[:, model.classes_] = model.predict_proba(XP[:, optical])
    model_hard = proba.argmax(axis=1)
    hard = np.where(high_rule_p, tea, model_hard)

    groups_path = os.path.join(cover_dir, 'groups.json')
    groups = json.load(open(groups_path, encoding='utf8')) if os.path.exists(groups_path) else None
    group_of = (groups or {}).get('parcels', {})
    by_key = {}
    for i, k in enumerate(key_p):
        by_key.setdefault(k, []).append(i)

    parcels = []
    for line in open(os.path.join(root, 'parcels.ndjson'), encoding='utf8'):
        if not line.strip():
            continue
        p = json.loads(line)['properties']
        idx = np.array(by_key.get(p['key'], []), int)
        g = group_of.get(p['key'])
        base = {'key': p['key'], 'block': p['block'], 'parcel': p['parcel'], 'nature': p['nature'], 'locality': p.get('locality', ''), 'areaM2': round(p['geometryAreaM2']), 'pixels': int(len(idx)),
                'group': g['dominant'] if g else None, 'groupShares': g['shares'] if g else None}
        if len(idx) < R['minPixels']:
            parcels.append({**base, 'tea': 'not_assessable', 'teaShare': None, 'teaProbability': None, 'dominant': None, 'dominantShare': None, 'shares': None, 'confidence': None, 'evidence': None, 'flags': []})
            continue
        shares = {c: round(float((hard[idx] == i).mean()), 3) for i, c in enumerate(CLASSES)}
        tea_share = shares['tea']
        top = max(shares, key=shares.get)
        state = 'present' if tea_share >= R['teaPresentShare'] else 'absent' if tea_share < R['teaAbsentShare'] else 'partial'
        tall = float(np.nanmean(eP['tall'][idx]))
        ratio = float(np.nanmean(eP['ratio'][idx]))
        rule_share = float(rule_p[idx].mean())
        rule_state = 'present' if rule_share >= R['teaPresentShare'] else 'absent' if rule_share < R['teaAbsentShare'] else 'partial'
        flags = []
        if state == 'present' and tall >= 0.5:
            flags.append('tea_under_canopy')        # the height map shows trees: tea under trees, or trees cleared since the map
        if state != 'present' and rule_state == 'present':
            flags.append('evergreen_open_not_tea')  # open and evergreen, yet the model does not read tea
        if state == 'present' and rule_state == 'absent':
            flags.append('rule_disagrees')
        promoted = state != 'absent' and float((model_hard[idx] == tea).mean()) < R['teaPresentShare'] <= tea_share
        if promoted:
            flags.append('high_altitude_rule')      # tea only by the relaxed winter rule of high ground
        certainty = float(proba[idx].max(axis=1).mean())
        agree = state == rule_state
        confidence = 'low' if len(idx) < R['fewPixels'] or (state != rule_state and 'partial' not in (state, rule_state)) else 'high' if agree and certainty >= 0.8 and not promoted else 'medium'
        parcels.append({
            **base, 'tea': state, 'teaShare': tea_share, 'teaProbability': round(float(proba[idx, tea].mean()), 3),
            'dominant': top if shares[top] >= R['dominantShare'] else 'mixed', 'dominantShare': shares[top], 'shares': shares, 'confidence': confidence,
            'elevationM': round(float(np.nanmean(elevation_p[idx]))),
            'evidence': {'canopyHeightM': round(float(np.nanmean(eP['height'][idx])), 1), 'tallShare': round(tall, 2), 'winterRatio': round(ratio, 2), 'ruleTeaShare': round(rule_share, 2), 'ruleState': rule_state},
            'flags': flags,
        })

    assessed = [p for p in parcels if p['tea'] != 'not_assessable']
    count = lambda key, values: {v: sum(1 for p in parcels if p[key] == v) for v in values}
    experiments_path = os.path.join(cover_dir, 'experiments.json')
    title_study = None
    if os.path.exists(experiments_path):
        ex = json.load(open(experiments_path, encoding='utf8'))
        best = next((r for r in ex['results'] if r['features'] == ex['bestCover']['features'] and r['learner'] == ex['bestCover']['learner'] and r['target'] == 'cover'), None)
        if best:
            title_study = {'features': best['features'], 'learner': best['learner'], 'teaAccuracy': best['teaAccuracy']['mean'], 'teaRecall': best['teaRecall']['mean'], 'teaPrecision': best['teaPrecision']['mean'],
                           'note': 'Tapu etiketleriyle eğitilen modelin, yine tapu etiketlerine karşı çapraz sınaması. Yüksek görünür, çünkü model tapuyu öğrenir; arazideki durumu ölçmez.'}
    used = next((c for c in comparison if c['key'] == 'consensus_optical_high'), None)
    by_elevation = []
    for label, lo, hi in (('800 m altı', 0, 800), ('800 m ve üzeri', 800, 99999)):
        own = [(r, key_p == k) for k, r in ref.items() if r['tea'] and lo <= float(np.nanmean(elevation_p[key_p == k])) < hi]
        by_elevation.append({'band': label, 'teaParcels': len(own), 'teaFound': sum(1 for r, m in own if 'consensus_optical_high' in held_out and held_out['consensus_optical_high'][m].mean() >= R['teaPresentShare'])})
    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'version': 2,
        'method': 'Her parselin 10 m pikselleri çay, ağaç örtüsü, açık alan ya da yapı olarak okunur. Eğitim etiketleri tapudan değil, iki fiziksel ölçütün uzlaştığı piksellerden gelir: ağaç yüksekliği (çay alçak çalıdır) ve kış yeşilliği (çay yaprağını dökmez). Sınıflandırıcı güncel Sentinel-2 verisiyle çalışır. Ön değerlendirmedir.',
        'rules': R, 'classes': CLASSES, 'labels': LABELS,
        'model': {
            'method': 'consensus', 'learner': 'boosting', 'bands': len(optical),
            'trainingPixels': {c: int((y_train[labelled] == i).sum()) for i, c in enumerate(CLASSES)}, 'unlabelledPixels': int((~labelled).sum()), 'markedPixels': int(len(F)),
            'reference': {'parcels': len(ref), 'tea': sum(1 for r in ref.values() if r['tea']), 'noTea': sum(1 for r in ref.values() if not r['tea']),
                          'drone': sum(1 for r in ref.values() if r['source'] == 'drone'), 'field': sum(1 for r in ref.values() if r['source'] == 'field'), 'disputed': disputed,
                          'note': 'Sınama parselleri bir kişinin baktığı parsellerdir: drone videosunda gözle okunanlar ve saha gözlemleri. Hiçbiri eğitimde kullanılmaz. Drone okumaları doğrulanmamıştır; “tartışmalı” olanlar, iki fiziksel ölçütün de açık ve her dem yeşil örtü gösterdiği “çay yok” okumalarıdır (çizimin birkaç metre kaymış olması olasıdır).'},
            'comparison': comparison, 'used': used, 'titleStudy': title_study, 'fieldValidation': field,
            'sources': [
                {'name': 'Sentinel-2 (2024–2026)', 'role': 'Sınıflandırıcının girdisi: mevsimlik bantlar, aylık yeşillik eğrisi, kış/yaz oranı.'},
                {'name': 'Meta / WRI ağaç yüksekliği haritası (1 m, görüntüler çoğunlukla 2018–2020)', 'role': 'Yalnız eğitim etiketlerini üretmek için; sınıflandırıcıya girdi değildir.'},
                {'name': 'Drone okumaları ve saha gözlemleri', 'role': 'Yalnız sınama için; eğitimde kullanılmaz.'},
            ],
            # Tea found among the reference tea parcels below and above the snow line of the winter composites.
            'byElevation': by_elevation,
            'validationNote': 'Sayılar tek mahalleden ve tek uçuştan gelen küçük bir sınama setine dayanır; başka bölgelerdeki başarımı göstermez. 800 m üzerinde kış karı çayın kış yeşilliğini bastırır; orada çay daha sık kaçırılır ve gevşetilmiş kış kuralı uygulanır. 800 m üzerinde "çay yok" olduğu bilinen sınama parseli yoktur; orada yanlış "çay var" oranı ölçülmemiştir.',
        },
        'unsupervised': None if not groups else {
            'generatedAt': groups['generatedAt'], 'method': groups['method'], 'rules': groups['rules'], 'pixels': groups['pixels'], 'groups': groups['groups'], 'titleConsistency': groups['titleConsistency'],
            'byGroup': {name: sum(1 for p in parcels if p['group'] == name) for name in [g['name'] for g in groups['groups']] + ['mixed']},
            'againstTrained': {state: {name: sum(1 for p in parcels if p['tea'] == state and p['group'] == name) for name in [g['name'] for g in groups['groups']] + ['mixed']} for state in ('present', 'partial', 'absent')},
        },
        'summary': {
            'parcels': len(parcels), 'assessed': len(assessed),
            'byTea': count('tea', ['present', 'partial', 'absent', 'not_assessable']),
            'byDominant': count('dominant', CLASSES + ['mixed']),
            'byConfidence': count('confidence', ['high', 'medium', 'low']),
            'byFlag': {f: sum(1 for p in parcels if f in p['flags']) for f in ('tea_under_canopy', 'evergreen_open_not_tea', 'rule_disagrees', 'high_altitude_rule')},
            'teaAreaM2': round(sum(p['teaShare'] * p['areaM2'] for p in assessed)),
            # Deed title against the reading, for the reader: how many titled tea gardens no longer read as tea.
            'titleTea': {state: sum(1 for p in assessed if p['nature'].strip().lower().startswith('çay bah') and p['tea'] == state) for state in ('present', 'partial', 'absent')},
            'titleOther': {state: sum(1 for p in assessed if not p['nature'].strip().lower().startswith('çay bah') and p['tea'] == state) for state in ('present', 'partial', 'absent')},
        },
        'parcels': parcels,
    }
    json.dump(out, open(os.path.join(cover_dir, 'cover.json'), 'w', encoding='utf8'), ensure_ascii=False)
    print('consensus pixels', out['model']['trainingPixels'], 'unlabelled', out['model']['unlabelledPixels'], '| disputed', len(disputed))
    print('parcels', len(parcels), 'assessed', len(assessed), out['summary']['byTea'], out['summary']['byDominant'], out['summary']['byConfidence'], out['summary']['byFlag'])
    print('title tea ->', out['summary']['titleTea'], '| other title ->', out['summary']['titleOther'])


if __name__ == '__main__':
    main()
