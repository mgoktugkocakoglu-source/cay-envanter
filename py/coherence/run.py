"""Burst-pair coherence for a neighbourhood season, then per-garden coherence series.

    .venv/Scripts/python py/coherence/run.py --dir data/library/trabzon/of/cataldere --season 2025 [--orbits 43,123] [--max-gap 12]

Step 1 runs the SNAP graph (coherence_pair.xml) for every consecutive pair of the same burst
(6- or 12-day), writing data/s1/<nbhd>/season-<s>/coh/<orbit>/<d1>_<d2>.tif (10 m, EPSG:4326).
Step 2 averages each coherence image over every garden polygon (the licensed tea sub-polygon
when the register exists) and writes <library>/pruning-radar/coherence-<season>.json:
    { season, passes: [{pass, relativeOrbit, pairs: [[d1, d2], ...]}], gardens: {id: {pass: [coh...]}} }
Pairs already processed are skipped, so the run can be resumed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

import numpy as np
import rasterio
from rasterio.mask import mask as rio_mask
from shapely.geometry import shape

GPT = Path(os.environ.get("SNAP_GPT", r"C:\Program Files\esa-snap\bin\gpt.exe"))
GRAPH = Path(__file__).with_name("coherence_pair.xml")
# SNAP requires an azimuth window > 1: 4 x 2 ~ 9 m x 28 m, the finest usable estimate.
COH_WIN_RG = 4
COH_WIN_AZ = 2


def boundary_wkt(meta: dict, pad: float = 0.004) -> str:
    """Neighbourhood bbox with a small pad so edge gardens keep full windows."""
    coords = json.dumps(meta["boundary"]["coordinates"])
    xs = [float(x) for x in re.findall(r"\[(-?\d+\.?\d*),\s*-?\d+\.?\d*\]", coords)]
    ys = [float(y) for y in re.findall(r"\[-?\d+\.?\d*,\s*(-?\d+\.?\d*)\]", coords)]
    w, s, e, n = min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad
    return f"POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))"


def run_pair(master: Path, slave: Path, out: Path, wkt: str) -> bool:
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(GPT), str(GRAPH), "-e", "-q", "4",
        f"-Pmaster={master}", f"-Pslave={slave}", f"-Poutput={out}", f"-Pwkt={wkt}",
        f"-PcohWinRg={COH_WIN_RG}", f"-PcohWinAz={COH_WIN_AZ}",
    ]
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    ok = proc.returncode == 0 and out.exists()
    tail = (proc.stderr or proc.stdout).strip().splitlines()[-3:]
    print(f"  {out.name}: {'ok' if ok else 'HATA'} ({time.time() - t0:.0f} s)" + ("" if ok else "\n    " + "\n    ".join(tail)))
    return ok


def garden_geometries(lib: Path) -> dict[str, dict]:
    """Garden id → GeoJSON geometry: register sub-polygons when present, else demo slices via node."""
    reg = lib / "licensing" / "registry.json"
    if reg.exists():
        data = json.loads(reg.read_text(encoding="utf-8"))
        return {g["code"]: g["versions"][-1]["geometry"] for g in data["gardens"]}
    raise SystemExit("licensing/registry.json yok; önce build-licensing çalıştırın (bahçe geometrileri oradan okunur).")


def zonal_mean(tif: Path, geoms: dict[str, dict]) -> dict[str, float | None]:
    out: dict[str, float | None] = {}
    with rasterio.open(tif) as src:
        for gid, geom in geoms.items():
            try:
                arr, _ = rio_mask(src, [geom], crop=True, all_touched=True, nodata=np.nan, filled=True)
            except ValueError:
                out[gid] = None
                continue
            vals = arr[0]
            vals = vals[np.isfinite(vals) & (vals > 0)]
            out[gid] = round(float(vals.mean()), 3) if vals.size else None
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--season", type=int, default=2025)
    ap.add_argument("--orbits", default="43,123")
    ap.add_argument("--max-gap", type=int, default=12, help="longest pair separation in days")
    ap.add_argument("--s1", default="data/s1")
    ap.add_argument("--skip-snap", action="store_true", help="only (re)compute garden series from existing tifs")
    args = ap.parse_args()

    lib = Path(args.dir)
    meta = json.loads((lib / "meta.json").read_text(encoding="utf-8"))
    season = f"{args.season}-{str(args.season + 1)[2:]}"
    s1dir = Path(args.s1) / lib.name / f"season-{season}"
    bursts = json.loads((s1dir / "bursts.json").read_text(encoding="utf-8"))
    orbits = {int(o) for o in args.orbits.split(",")}
    wkt = boundary_wkt(meta)
    geoms = garden_geometries(lib)
    print(f"{season}: {len(geoms)} bahçe, yörüngeler {sorted(orbits)}")

    passes = []
    series: dict[str, dict[str, list[float | None]]] = {gid: {} for gid in geoms}
    for orbit in sorted(orbits):
        items = [b for b in bursts if b["relativeOrbit"] == orbit and (b["cover"] or 0) >= 0.5]
        if not items:
            print(f"yörünge {orbit}: burst yok")
            continue
        burst_id = max({b["burstId"] for b in items}, key=lambda k: sum(1 for b in items if b["burstId"] == k))
        pass_name = items[0]["pass"]
        # SAFE products assembled by burst2stack (data/s1/<nbhd>/safe/<orbit>/S1?_IW_SLC__1SSV_<date>T...SAFE).
        safe_dir = Path(args.s1) / lib.name / "safe" / str(orbit)
        files: dict[str, Path] = {}
        for safe in sorted(safe_dir.glob("S1*_IW_SLC__*.SAFE")):
            m = re.search(r"_(\d{8})T\d{6}_", safe.name)
            if m and (safe / "manifest.safe").exists():
                d = m.group(1)
                files[f"{d[:4]}-{d[4:6]}-{d[6:]}"] = safe / "manifest.safe"
        dates = sorted(files)
        print(f"yörünge {orbit} ({pass_name}, {burst_id}): {len(dates)} SAFE")
        pairs: list[list[str]] = []
        coh_dir = s1dir / "coh" / str(orbit)
        for d1, d2 in zip(dates, dates[1:]):
            gap = (date.fromisoformat(d2) - date.fromisoformat(d1)).days
            if gap > args.max_gap:
                print(f"  {d1} → {d2}: {gap} gün, atlandı")
                continue
            out = coh_dir / f"{d1}_{d2}.tif"
            if not out.exists() and not args.skip_snap:
                if not run_pair(files[d1], files[d2], out, wkt):
                    continue
            if out.exists():
                pairs.append([d1, d2])
        passes.append({"pass": pass_name, "relativeOrbit": orbit, "burstId": burst_id, "pairs": pairs})
        for gid in geoms:
            series[gid][pass_name] = []
        for d1, d2 in pairs:
            means = zonal_mean(coh_dir / f"{d1}_{d2}.tif", geoms)
            for gid in geoms:
                series[gid][pass_name].append(means[gid])
        print(f"  {len(pairs)} çift işlendi")

    out_path = lib / "pruning-radar" / f"coherence-{season}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"season": season, "cohWin": [COH_WIN_RG, COH_WIN_AZ], "passes": passes, "gardens": series}), encoding="utf-8")
    print(f"Çıktı: {out_path}")


if __name__ == "__main__":
    sys.exit(main())
