"""Independent reference parcels for the land-cover module: what a person saw, never a deed title.

  .venv/Scripts/python.exe py/cover_reference.py data/library/<province>/<district>/<neighbourhood>

Collects, into land-cover/reference.json, the parcels whose cover someone has looked at:
  - drone  : parcels read frame by frame in the drone video (drone/verification.json) as "tea present" or "tea not
             found", low-confidence, partial and uncertain readings left out. These readings are visual and unverified,
             and "tea not found" is almost always "closed tree canopy": tea hidden under trees cannot be excluded.
  - field  : ground observations recorded with the licence audit (licence-audit/audit.json); they overrule a drone reading.
Marked areas drawn on the site are a separate, stronger reference (field-samples.csv) and are not listed here.

The file is the test set of py/cover_experiments.py. It is small and comes from one neighbourhood and one flight:
it shows whether a model reads the ground or the title, not how it performs elsewhere.
"""
import json
import os
import sys


def main():
    root = sys.argv[1]
    out = {}
    drone_path = os.path.join(root, 'drone', 'verification.json')
    if os.path.exists(drone_path):
        for p in json.load(open(drone_path, encoding='utf8'))['parcels']:
            if p.get('classSource') != 'review' or p.get('confidence') == 'low' or p['class'] not in ('tea_present', 'tea_not_found'):
                continue
            out[p['key']] = {'key': p['key'], 'parcel': p['block'] + '/' + p['parcel'], 'tea': p['class'] == 'tea_present', 'source': 'drone', 'note': (p.get('review') or {}).get('note', '')}
    audit_path = os.path.join(root, 'licence-audit', 'audit.json')
    if os.path.exists(audit_path):
        for p in json.load(open(audit_path, encoding='utf8'))['parcels']:
            c = p.get('confirmation')
            if c and c.get('tea') is not None:
                out[p['key']] = {'key': p['key'], 'parcel': p['block'] + '/' + p['parcel'], 'tea': bool(c['tea']), 'source': 'field', 'note': c.get('note', '')}
    rows = sorted(out.values(), key=lambda r: r['parcel'])
    os.makedirs(os.path.join(root, 'land-cover'), exist_ok=True)
    json.dump({'parcels': rows, 'note': 'Drone okumaları görseldir ve doğrulanmamıştır; "çay bulunamadı" çoğunlukla kapalı ağaç örtüsüdür.'}, open(os.path.join(root, 'land-cover', 'reference.json'), 'w', encoding='utf8'), ensure_ascii=False)
    count = lambda src, tea: sum(1 for r in rows if r['source'] == src and r['tea'] == tea)
    print('reference parcels', len(rows), '| drone tea', count('drone', True), 'no tea', count('drone', False), '| field tea', count('field', True), 'no tea', count('field', False))


if __name__ == '__main__':
    main()
