"""
Per-season Sentinel-2 imagery for the site's pruning map: true-colour composites of the three
compared windows (reference, winter, spring) and a change layer showing where tea lost greenness
against the neighbourhood (the pruning signal). Same windows, cloud/snow masks and scene screening
as src/ee/pruning.ts, so what the map shows is what the detector compared.

Uses ee.data.computePixels (needs only earthengine.computations.create; the service account has
no thumbnail permission).

Usage:
  .venv/Scripts/python py/season_imagery.py --dir data/library/trabzon/of/cataldere --seasons 2023,2024,2025
"""
import argparse
import json
from pathlib import Path

import ee

CLEAR_THRESHOLD = 0.6
SNOW_NDSI = 0.4
MIN_SCENE_TEA_MEDIAN = 0.55
# ~5 m in degrees at 41°N: finer than the 10 m data so the bicubic resampling reads smooth when zoomed.
STEP_DEG = 0.00005
# Change layer: relative NDVI drop shown from 0.10 (faint, near the detector threshold) to 0.35 (strong).
CHANGE_MIN, CHANGE_MAX = 0.10, 0.35


def windows(year: int) -> dict:
    nxt = year + 1
    return {
        'season': f'{year}-{str(nxt)[2:]}',
        'reference': (f'{year}-10-05', f'{year}-11-10'),
        'winter': (f'{year}-12-10', f'{nxt}-02-01'),
        'spring': (f'{nxt}-03-20', f'{nxt}-04-11'),
    }


def init_ee(key_path: Path) -> None:
    key = json.loads(key_path.read_text(encoding='utf-8'))
    ee.Initialize(ee.ServiceAccountCredentials(key['client_email'], str(key_path)), project=key['project_id'])


def clear_collection(region, tea_mask, start: str, end: str):
    cloud_score = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED')

    def prepare(image):
        scaled = image.select(['B2', 'B3', 'B4', 'B8', 'B11']).divide(10_000)
        not_snow = scaled.normalizedDifference(['B3', 'B11']).lt(SNOW_NDSI).And(image.select('SCL').neq(11))
        bands = scaled.addBands(scaled.normalizedDifference(['B8', 'B4']).rename('NDVI')).updateMask(
            image.select('cs_cdf').gte(CLEAR_THRESHOLD).And(not_snow))
        tea_median = bands.select('NDVI').updateMask(tea_mask).reduceRegion(
            reducer=ee.Reducer.median(), geometry=region, scale=20, maxPixels=1e9).get('NDVI')
        return bands.copyProperties(image, ['system:time_start']).set('teaMedian', ee.Algorithms.If(tea_median, tea_median, -1))

    return (ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED').filterBounds(region).filterDate(start, end)
            .linkCollection(cloud_score, ['cs_cdf']).map(prepare)
            .filter(ee.Filter.gte('teaMedian', MIN_SCENE_TEA_MEDIAN)))


def relative_change(before, after, tea_mask, region):
    delta = after.select('NDVI').subtract(before.select('NDVI')).updateMask(tea_mask)
    median = delta.reduceRegion(reducer=ee.Reducer.median(), geometry=region, scale=10, maxPixels=1e9).values().get(0)
    return delta.subtract(ee.Number(median))


def best_scene(collection, region, tea_mask, start: str, end: str):
    """The single scene that saw most of the tea clearly (ties: closest to the window's middle).

    One sharp scene with an exact date reads far better than a median of several, which smears
    the small misregistrations between scenes and mixes their shadows.
    """
    middle = ee.Date(start).advance(ee.Date(end).difference(ee.Date(start), 'day').divide(2), 'day')

    def score(image):
        # Share of the TEA pixels that are clear and snow-free in this scene.
        valid = image.select('NDVI').mask().updateMask(tea_mask).reduceRegion(
            reducer=ee.Reducer.mean(), geometry=region, scale=20, maxPixels=1e9).values().get(0)
        days = ee.Number(image.date().difference(middle, 'day')).abs()
        return image.set('validTea', valid, 'rank', ee.Number(valid).multiply(1000).subtract(days))

    return ee.Image(collection.map(score).sort('rank', False).first())


def stretched_rgb(image, region):
    """True colour with a 2–98 % stretch of this scene: low winter sun no longer reads as black."""
    rgb = image.select(['B4', 'B3', 'B2']).resample('bicubic')
    stats = rgb.reduceRegion(reducer=ee.Reducer.percentile([2, 98]), geometry=region, scale=20, maxPixels=1e9)
    lo = [ee.Number(stats.get(f'{b}_p2')) for b in ('B4', 'B3', 'B2')]
    hi = [ee.Number(stats.get(f'{b}_p98')) for b in ('B4', 'B3', 'B2')]
    return rgb.visualize(min=ee.List(lo), max=ee.List(hi), gamma=1.1)


def png(image, bbox, path: Path, file_format: str = 'PNG') -> None:
    west, south, east, north = bbox
    width = round((east - west) / STEP_DEG)
    height = round((north - south) / STEP_DEG)
    data = ee.data.computePixels({
        'expression': image,
        'fileFormat': file_format,
        'grid': {
            'dimensions': {'width': width, 'height': height},
            'affineTransform': {'scaleX': STEP_DEG, 'shearX': 0, 'translateX': west,
                                'shearY': 0, 'scaleY': -STEP_DEG, 'translateY': north},
            'crsCode': 'EPSG:4326',
        },
    })
    path.write_bytes(data)
    print(f'  {path.name}: {width}x{height}, {len(data) // 1024} KB')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dir', required=True, help='neighbourhood library folder')
    parser.add_argument('--seasons', default='2023,2024,2025')
    parser.add_argument('--key', default='secrets/ee-key.json')
    args = parser.parse_args()

    init_ee(Path(args.key))
    folder = Path(args.dir)
    meta = json.loads((folder / 'meta.json').read_text(encoding='utf-8'))
    patches = json.loads((folder / 'tea-patches.geojson').read_text(encoding='utf-8'))
    region = ee.Geometry(meta['boundary'])
    coords = [c for ring in meta['boundary']['coordinates'] for c in ring]
    pad = 0.001
    bbox = (min(c[0] for c in coords) - pad, min(c[1] for c in coords) - pad,
            max(c[0] for c in coords) + pad, max(c[1] for c in coords) + pad)
    tea_mask = ee.Image(0).byte().paint(
        ee.FeatureCollection([ee.Feature(ee.Geometry(f['geometry'])) for f in patches['features']]), 1).eq(1)

    out = folder / 'pruning' / 'imagery'
    out.mkdir(parents=True, exist_ok=True)
    index = {'bounds': {'west': bbox[0], 'south': bbox[1], 'east': bbox[2], 'north': bbox[3]}, 'seasons': {}}
    for year in [int(y) for y in args.seasons.split(',')]:
        w = windows(year)
        print(f"Sezon {w['season']}")
        composites = {}
        layers = {}
        for name in ('reference', 'winter', 'spring'):
            col = clear_collection(region, tea_mask, *w[name])
            # The change layer compares composites (as the detector does); the photo shows one real scene.
            composites[name] = col.median()
            scene = best_scene(col, region, tea_mask, *w[name])
            info = ee.Dictionary({'date': scene.date().format('YYYY-MM-dd'), 'valid': scene.get('validTea')}).getInfo()
            file = f"{w['season']}-{name}.jpg"
            png(stretched_rgb(scene, region), bbox, out / file, 'JPEG')
            layers[name] = {'file': file, 'scenes': col.size().getInfo(), 'window': list(w[name]),
                            'sceneDate': info['date'], 'teaVisible': round(info['valid'] or 0, 3)}
        # Pruning signal: the stronger of the winter and March drops, on tea pixels only.
        drop = (relative_change(composites['reference'], composites['winter'], tea_mask, region)
                .min(relative_change(composites['winter'], composites['spring'], tea_mask, region))
                .multiply(-1))
        change = drop.updateMask(drop.gte(CHANGE_MIN)).visualize(
            min=CHANGE_MIN, max=CHANGE_MAX, palette=['fde68a', 'f97316', 'b91c1c'])
        file = f"{w['season']}-change.png"
        png(change, bbox, out / file)
        layers['change'] = {'file': file}
        index['seasons'][w['season']] = layers
    (out / 'index.json').write_text(json.dumps(index, indent=2), encoding='utf-8')
    print(f'Çıktı: {out}')


if __name__ == '__main__':
    main()
