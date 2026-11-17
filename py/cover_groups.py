"""Cover groups with no reference at all: pixels grouped by how green they are through the year, then named by physics.

  .venv/Scripts/python.exe py/cover_groups.py data/library/<province>/<district>/<neighbourhood>

Input : land-cover/pixels.csv (npm run sample-cover). Output: land-cover/groups.json (merged into cover.json by cover_classify).

No deed title, no land-cover map and no trained model is used. Every pixel of the neighbourhood's parcels is described by
its monthly NDVI through the year and a few reflectances; k-means puts pixels that behave alike together. Each group is
then named from its own average curve with fixed rules: how green it is, and how much of its summer greenness it keeps
in winter. Tea is an evergreen shrub, so it lands in the group that stays green and bright in mid-winter; hazelnut and
broadleaf forest drop their leaves and cannot.

Radar is left out on purpose: uncorrected backscatter follows the slope of the terrain here and groups pixels by
hillside instead of by cover.

What this cannot give: an accuracy figure (there is nothing to compare with), and a split between tea and other
evergreens (conifers, laurel) inside the evergreen group. The naming thresholds are physical choices, not calibrated.
"""
import csv
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

MONTHS = ['NDVI_m%02d' % i for i in range(1, 13)]
FEATURES = MONTHS + ['NDVI_p10', 'NDVI_p50', 'NDVI_p90', 'evergreen', 'B8_sum', 'B11_sum', 'B4_sum', 'B8_off', 'B11_off']
RULES = {
    'clusters': 8,
    'seed': 7,
    # Median NDVI of the year: below the first there is no vegetation, below the second hardly any, below the third it is thin or mixed with buildings.
    'bareNdvi': 0.15,
    'builtNdvi': 0.40,
    'sparseNdvi': 0.62,
    # Winter (Dec-Feb) greenness as a share of summer (Jun-Aug) greenness.
    'evergreenRatio': 0.80,
    'deciduousRatio': 0.60,
    # An evergreen group this dark in the near infrared in winter lies in terrain shadow: the cover cannot be told there.
    'shadowWinterNir': 0.20,
    'minPixels': 3,
    'dominantShare': 0.5,
}
# Order = severity of the claim; the evergreen group is the only one that can hold tea.
GROUPS = {
    'evergreen': 'Her dem yeşil (çay adayı)',
    'evergreen_shadow': 'Her dem yeşil, kışın gölgede',
    'semi_evergreen': 'Kışın kısmen yeşil (karışık örtü)',
    'deciduous': 'Kışın yaprak döken',
    'sparse': 'Seyrek örtü / yapı ile karışık',
    'built': 'Yapı / yol',
    'bare': 'Çıplak zemin / su',
}
NOTES = {
    'evergreen': 'Kış ortasında da yeşil ve parlak. Çay bu gruptadır; iğne yapraklı ağaçlar ve defne gibi diğer her dem yeşiller de buraya düşebilir.',
    'evergreen_shadow': 'Yeşilliğini koruyor ama kışın arazi gölgesinde kaldığı için örtü okunamıyor: çay da olabilir, orman da.',
    'semi_evergreen': 'Kışın yeşilliğinin bir kısmını kaybediyor: yapraklı ve her dem yeşil karışımı, ya da ağaç altı çay.',
    'deciduous': 'Kışın yaprağını döküyor: fındık, yapraklı orman, çayır. Çay bu grupta olamaz.',
    'sparse': 'Yıl boyu ince bir yeşillik: bahçe ile yapının karıştığı pikseller, seyrek örtü.',
    'built': 'Yıl boyu çok az yeşillik: yapı, yol, avlu.',
    'bare': 'Bitki yok: çıplak zemin, su.',
}


def name_of(c):
    R = RULES
    if c['ndvi'] < R['bareNdvi']:
        return 'bare'
    if c['ndvi'] < R['builtNdvi']:
        return 'built'
    if c['ndvi'] < R['sparseNdvi']:
        return 'sparse'
    if c['ratio'] >= R['evergreenRatio']:
        return 'evergreen_shadow' if c['winterNir'] < R['shadowWinterNir'] else 'evergreen'
    return 'deciduous' if c['ratio'] <= R['deciduousRatio'] else 'semi_evergreen'


def main():
    root = sys.argv[1]
    cover_dir = os.path.join(root, 'land-cover')
    rows = [r for r in csv.DictReader(open(os.path.join(cover_dir, 'pixels.csv'), encoding='utf8')) if all(r[b] != '' for b in FEATURES)]
    X = np.array([[float(r[b]) for b in FEATURES] for r in rows], np.float32)
    scaler = StandardScaler().fit(X)
    km = KMeans(n_clusters=RULES['clusters'], n_init=10, random_state=RULES['seed']).fit(scaler.transform(X))
    col = lambda b: FEATURES.index(b)

    clusters = []
    for c in range(RULES['clusters']):
        m = X[km.labels_ == c]
        if not len(m):
            continue
        monthly = [float(m[:, col(b)].mean()) for b in MONTHS]
        winter, summer = float(np.mean([monthly[11], monthly[0], monthly[1]])), float(np.mean(monthly[5:8]))
        centre = {'ndvi': float(m[:, col('NDVI_p50')].mean()), 'ndviLow': float(m[:, col('NDVI_p10')].mean()), 'winter': winter, 'summer': summer, 'ratio': winter / max(summer, 1e-6), 'winterNir': float(m[:, col('B8_off')].mean())}
        clusters.append({'cluster': c, 'name': name_of(centre), 'pixels': int(len(m)), 'centre': {k: round(v, 3) for k, v in centre.items()}, 'monthly': [round(v, 3) for v in monthly]})
    name_by_cluster = {c['cluster']: c['name'] for c in clusters}
    pixel_group = np.array([name_by_cluster[c] for c in km.labels_])

    # Groups shown to the user: clusters with the same name are merged.
    groups = []
    for name in GROUPS:
        own = [c for c in clusters if c['name'] == name]
        if not own:
            continue
        n = sum(c['pixels'] for c in own)
        avg = lambda key: round(sum(c['centre'][key] * c['pixels'] for c in own) / n, 3)
        groups.append({'name': name, 'label': GROUPS[name], 'note': NOTES[name], 'pixels': n, 'share': round(n / len(rows), 4), 'clusters': len(own),
                       'centre': {k: avg(k) for k in own[0]['centre']}, 'monthly': [round(sum(c['monthly'][i] * c['pixels'] for c in own) / n, 3) for i in range(12)]})

    by_key = {}
    for r, g in zip(rows, pixel_group):
        by_key.setdefault(r['key'], []).append(g)
    parcels = {}
    for key, gs in by_key.items():
        if len(gs) < RULES['minPixels']:
            continue
        shares = {name: round(gs.count(name) / len(gs), 3) for name in GROUPS if gs.count(name)}
        top = max(shares, key=shares.get)
        parcels[key] = {'pixels': len(gs), 'shares': shares, 'dominant': top if shares[top] >= RULES['dominantShare'] else 'mixed'}

    # Not an accuracy measure: where the pixels of clean deed titles fall, as a plausibility note for the reader.
    consistency = None
    samples_path = os.path.join(cover_dir, 'samples.csv')
    if os.path.exists(samples_path):
        samples = [r for r in csv.DictReader(open(samples_path, encoding='utf8')) if r['grp'] != 'map' and all(r[b] != '' for b in FEATURES)]
        labels = km.predict(scaler.transform(np.array([[float(r[b]) for b in FEATURES] for r in samples], np.float32)))
        consistency = {}
        for cls in ('tea', 'hazelnut', 'forest'):
            own = [name_by_cluster[l] for r, l in zip(samples, labels) if r['cls'] == cls]
            if own:
                consistency[cls] = {'pixels': len(own), 'shares': {name: round(own.count(name) / len(own), 3) for name in GROUPS if own.count(name)}}

    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'method': 'Kıyassız gruplama: parsellerin bütün pikselleri, yıl içindeki aylık yeşillik eğrilerine göre kendiliğinden gruplanır (k-ortalamalar); gruplar kendi ortalama eğrilerinden sabit fiziksel kurallarla adlandırılır. Tapu, arazi örtüsü haritası ya da eğitilmiş model kullanılmaz. Doğruluk yüzdesi verilemez; adlandırma eşikleri kalibre edilmemiştir.',
        'rules': RULES, 'features': FEATURES, 'pixels': len(rows), 'groups': groups, 'clusters': clusters, 'titleConsistency': consistency, 'parcels': parcels,
    }
    json.dump(out, open(os.path.join(cover_dir, 'groups.json'), 'w', encoding='utf8'), ensure_ascii=False)
    for g in groups:
        print('%-18s %6d px %5.1f %%  ndvi %.2f  winter/summer %.2f  winter NIR %.2f  (%d clusters)' % (g['name'], g['pixels'], g['share'] * 100, g['centre']['ndvi'], g['centre']['ratio'], g['centre']['winterNir'], g['clusters']))
    print('parcels', len(parcels), {n: sum(1 for p in parcels.values() if p['dominant'] == n) for n in list(GROUPS) + ['mixed']})
    print('title consistency (not accuracy):', json.dumps(consistency))


if __name__ == '__main__':
    main()
