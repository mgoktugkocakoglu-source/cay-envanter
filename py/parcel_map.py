"""Picture of one parcel: its cadastral outline (and its neighbours') over a public aerial basemap.

  .venv/Scripts/python.exe py/parcel_map.py data/library/<province>/<district>/<neighbourhood> 252/30 out.jpg

Reads only parcels.ndjson; fetches the basemap tiles that cover the parcel (Esri World Imagery, no key) and draws on
them. The basemap is context, not evidence: its capture date is unknown and may be years old. Where the deepest zoom
levels hold no imagery the deepest level that does is used and enlarged by plain interpolation (no sharpening); the
footer states the ground size of a basemap pixel.
"""
import json
import math
import sys
import urllib.request

import cv2
import numpy as np

TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
TILE = 256
MAX_ZOOM = 19
MIN_ZOOM = 15
TARGET_PX = 600      # the parcel should span about this many pixels
MARGIN = 0.6         # context around the parcel, as a share of its size


def to_pixel(lon, lat, z):
    n = TILE * 2 ** z
    s = math.sin(math.radians(lat))
    return (lon + 180) / 360 * n, (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n


def rings(geometry):
    polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
    return [ring for polygon in polygons for ring in polygon]


def main():
    root, wanted, out = sys.argv[1], sys.argv[2], sys.argv[3]
    features = [json.loads(line) for line in open(root + '/parcels.ndjson', encoding='utf8') if line.strip()]
    target = next((f for f in features if f['properties']['block'] + '/' + f['properties']['parcel'] == wanted), None)
    if target is None:
        print('parcel not in library')
        sys.exit(2)
    pts = [p for ring in rings(target['geometry']) for p in ring]
    lon0, lon1 = min(p[0] for p in pts), max(p[0] for p in pts)
    lat0, lat1 = min(p[1] for p in pts), max(p[1] for p in pts)
    def fetch(z, tx, ty):
        request = urllib.request.Request(TILES.format(z=z, x=tx, y=ty), headers={'User-Agent': 'parcel-map'})
        return cv2.imdecode(np.frombuffer(urllib.request.urlopen(request, timeout=30).read(), np.uint8), cv2.IMREAD_COLOR)

    # deepest zoom level that holds imagery here: the "no data" placeholder is a flat grey tile with a little text
    zoom = MAX_ZOOM
    while zoom > MIN_ZOOM:
        cx, cy = to_pixel((lon0 + lon1) / 2, (lat0 + lat1) / 2, zoom)
        probe = fetch(zoom, int(cx // TILE), int(cy // TILE))
        if probe is not None and float((np.abs(probe.astype(int) - 204).max(axis=2) < 3).mean()) < 0.8:
            break
        zoom -= 1
    (ax, ay), (bx, by) = to_pixel(lon0, lat1, zoom), to_pixel(lon1, lat0, zoom)
    scale = float(np.clip(TARGET_PX / max(bx - ax, by - ay, 1), 0.25, 8))
    pad = max(bx - ax, by - ay) * MARGIN + 40 / scale
    left, top, right, bottom = ax - pad, ay - pad, bx + pad, by + pad
    tx0, ty0, tx1, ty1 = int(left // TILE), int(top // TILE), int(right // TILE), int(bottom // TILE)
    canvas = np.zeros(((ty1 - ty0 + 1) * TILE, (tx1 - tx0 + 1) * TILE, 3), np.uint8)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            tile = fetch(zoom, tx, ty)
            if tile is not None:
                canvas[(ty - ty0) * TILE:(ty - ty0 + 1) * TILE, (tx - tx0) * TILE:(tx - tx0 + 1) * TILE] = tile
    ox, oy = tx0 * TILE, ty0 * TILE
    canvas = cv2.resize(canvas, None, fx=scale, fy=scale, interpolation=cv2.INTER_LINEAR if scale > 1 else cv2.INTER_AREA)
    shape = lambda ring: np.array([[round((x - ox) * scale), round((y - oy) * scale)] for x, y in (to_pixel(lon, lat, zoom) for lon, lat in ring)], np.int32)
    view = tuple(v * scale for v in (left - ox, top - oy, right - ox, bottom - oy))
    for f in features:
        if f is target:
            continue
        for ring in rings(f['geometry']):
            s = shape(ring)
            if s[:, 0].max() < view[0] or s[:, 0].min() > view[2] or s[:, 1].max() < view[1] or s[:, 1].min() > view[3]:
                continue
            cv2.polylines(canvas, [s], True, (255, 255, 255), 1, cv2.LINE_AA)
            p = f['properties']
            cx, cy = int(s[:, 0].mean()), int(s[:, 1].mean())
            label = p['block'] + '/' + p['parcel']
            cv2.putText(canvas, label, (cx - 18, cy), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(canvas, label, (cx - 18, cy), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (255, 255, 255), 1, cv2.LINE_AA)
    for ring in rings(target['geometry']):
        cv2.polylines(canvas, [shape(ring)], True, (0, 0, 0), 5, cv2.LINE_AA)
        cv2.polylines(canvas, [shape(ring)], True, (0, 230, 255), 3, cv2.LINE_AA)
    crop = canvas[max(int(view[1]), 0):int(view[3]), max(int(view[0]), 0):int(view[2])].copy()
    # scale bar
    native_m = 156543.03392 * math.cos(math.radians((lat0 + lat1) / 2)) / 2 ** zoom
    metres_per_px = native_m / scale
    bar_m = next(m for m in (5, 10, 20, 50, 100, 200, 500, 1000) if m / metres_per_px >= 60)
    h = crop.shape[0]
    x0, x1, y = 14, 14 + round(bar_m / metres_per_px), h - 34
    cv2.rectangle(crop, (0, h - 58), (crop.shape[1], h), (0, 0, 0), -1)
    cv2.line(crop, (x0, y), (x1, y), (255, 255, 255), 2)
    cv2.putText(crop, '%d m' % bar_m, (x1 + 8, y + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.putText(crop, 'Sinir: TKGM | Altlik: Esri World Imagery, %.1f m/piksel, tarihi bilinmiyor' % native_m, (14, h - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY, 90])[1].tofile(out)
    print('ok zoom %d scale %.2f native %.2f m/px size %dx%d' % (zoom, scale, native_m, crop.shape[1], crop.shape[0]))


if __name__ == '__main__':
    main()
