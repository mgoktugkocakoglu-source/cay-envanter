"""Sentinel-1 burst coherence for a neighbourhood season through ASF HyP3 (free On Demand credits),
then per-garden coherence series in the same file format as py/coherence/run.py.

    .venv/Scripts/python py/hyp3_coherence.py --dir data/library/trabzon/of/cataldere --season 2025 [--orbits 43,123] [--max-gap 12] [--looks 5x1] [--dry-run]

Steps
  1. Reads data/s1/<nbhd>/season-<s>/bursts.json (from py/s1_bursts.py, VV bursts intersecting the
     neighbourhood). For every relative orbit the burst covering the neighbourhood best is kept and
     consecutive acquisitions (gap ≤ --max-gap days) form the pairs.
  2. Submits one HyP3 Burst InSAR (ISCE2) job per pair (looks 5x1 → 20 m pixels; 1 credit per pair at
     this size, 8 000 credits / month free). Jobs already present under the same name are reused, so
     the script can be re-run until all jobs are finished.
  3. Downloads the finished products, keeps only *_corr.tif (normalised coherence 0–1, UTM), averages
     each over every garden polygon (licensing/registry.json sub-polygons) and writes
     <library>/pruning-radar/coherence-hyp3-<season>.json:
       { season, source: "hyp3", looks, passes: [{pass, relativeOrbit, burstId, pairs}], gardens: {id: {pass: [coh…]}} }
     fuse-pruning / detect-pruning-radar prefer this file over the SNAP one when present.

Credentials: secrets/earthdata.txt ("Kullanıcı:" / "Şifre:" lines, gitignored). HyP3 keeps download
links 14 days; products are cached under data/s1/<nbhd>/hyp3/<orbit>/.
"""
from __future__ import annotations

import sys as _sys

if hasattr(_sys.stdout, "reconfigure"):
    _sys.stdout.reconfigure(encoding="utf-8")

import argparse
import json
import re
import sys
import time
import zipfile
from datetime import date
from pathlib import Path

import numpy as np
import rasterio
from rasterio.mask import mask as rio_mask
from rasterio.warp import transform_geom

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s1_bursts import read_credentials  # noqa: E402

JOB_PREFIX = "cay-coh"


def garden_geometries(lib: Path) -> dict[str, dict]:
    reg = lib / "licensing" / "registry.json"
    if not reg.exists():
        raise SystemExit("licensing/registry.json yok; önce build-licensing çalıştırın (bahçe geometrileri oradan okunur).")
    data = json.loads(reg.read_text(encoding="utf-8"))
    return {g["code"]: g["versions"][-1]["geometry"] for g in data["gardens"]}


def zonal_mean(tif: Path, geoms: dict[str, dict]) -> dict[str, float | None]:
    out: dict[str, float | None] = {}
    with rasterio.open(tif) as src:
        for gid, geom in geoms.items():
            try:
                g = transform_geom("EPSG:4326", src.crs, geom)
                arr, _ = rio_mask(src, [g], crop=True, all_touched=True, nodata=np.nan, filled=True)
            except ValueError:
                out[gid] = None
                continue
            vals = arr[0]
            vals = vals[np.isfinite(vals) & (vals > 0)]
            out[gid] = round(float(vals.mean()), 3) if vals.size else None
    return out


def granule_name(b: dict) -> str:
    """HyP3 wants the burst granule name (…-BURST), which ASF reports as fileID / fileName stem."""
    name = b.get("fileID") or b["fileName"]
    return re.sub(r"\.(tiff?|xml)$", "", name)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--season", type=int, default=2025)
    ap.add_argument("--orbits", default="", help="comma-separated relative orbits (default: all with cover ≥ --min-cover)")
    ap.add_argument("--min-cover", type=float, default=0.5)
    ap.add_argument("--max-gap", type=int, default=12, help="longest pair separation in days")
    ap.add_argument("--looks", default="5x1", choices=["20x4", "10x2", "5x1"])
    ap.add_argument("--s1", default="data/s1")
    ap.add_argument("--dry-run", action="store_true", help="list the pairs and credits, submit nothing")
    ap.add_argument("--no-wait", action="store_true", help="submit and exit; re-run later to download")
    ap.add_argument("--max-pairs", type=int, default=0, help="submit at most N pairs per orbit (test)")
    args = ap.parse_args()

    lib = Path(args.dir)
    season = f"{args.season}-{str(args.season + 1)[2:]}"
    s1dir = Path(args.s1) / lib.name / f"season-{season}"
    bursts_path = s1dir / "bursts.json"
    if not bursts_path.exists():
        raise SystemExit(f"{bursts_path} yok; önce `py/s1_bursts.py --dir {lib} --season {args.season}` (indirme olmadan) çalıştırın.")
    bursts = json.loads(bursts_path.read_text(encoding="utf-8"))
    wanted_orbits = {int(o) for o in args.orbits.split(",") if o.strip()}
    geoms = garden_geometries(lib)
    # Pruning season window for the pairs (Oct → Apr), one month of lead for the first pair.
    start, end = date(args.season, 9, 20), date(args.season + 1, 5, 1)

    plan: list[dict] = []
    for orbit in sorted({b["relativeOrbit"] for b in bursts}):
        if wanted_orbits and orbit not in wanted_orbits:
            continue
        items = [b for b in bursts if b["relativeOrbit"] == orbit and b["polarization"] == "VV" and (b["cover"] or 0) >= args.min_cover]
        if not items:
            continue
        burst_id = max({b["burstId"] for b in items}, key=lambda k: sum(1 for b in items if b["burstId"] == k))
        series = sorted((b for b in items if b["burstId"] == burst_id and start <= date.fromisoformat(b["date"]) <= end), key=lambda b: b["date"])
        pairs = []
        for a, b in zip(series, series[1:]):
            gap = (date.fromisoformat(b["date"]) - date.fromisoformat(a["date"])).days
            if 0 < gap <= args.max_gap:
                pairs.append((a, b))
        if args.max_pairs:
            pairs = pairs[: args.max_pairs]
        plan.append({"orbit": orbit, "pass": items[0]["pass"], "burstId": burst_id, "pairs": pairs})
        print(f"yörünge {orbit} ({items[0]['pass']}, {burst_id}, kapsama %{round((items[0]['cover'] or 0) * 100)}): {len(series)} tarih, {len(pairs)} çift")
    total = sum(len(p["pairs"]) for p in plan)
    print(f"Toplam {total} çift → {args.looks} bakış, ~{total} kredi")
    if args.dry_run or total == 0:
        return

    from hyp3_sdk import HyP3  # imported late: the dry run needs no login

    user, pw = read_credentials(Path("secrets/earthdata.txt"))
    hyp3 = HyP3(username=user, password=pw)
    my = hyp3.my_info()
    print(f"HyP3 kredi: {my.get('remaining_credits', '?')}")
    existing = {j.name: j for j in hyp3.find_jobs() if j.name and j.name.startswith(JOB_PREFIX)}
    print(f"Mevcut iş: {len(existing)}")

    jobs_by_name: dict[str, object] = {}
    for p in plan:
        for a, b in p["pairs"]:
            name = f"{JOB_PREFIX}-{lib.name}-{p['orbit']}-{a['date']}_{b['date']}-{args.looks}"
            job = existing.get(name)
            if job is None:
                try:
                    job = hyp3.submit_insar_isce_burst_job(granule_name(a), granule_name(b), name=name, looks=args.looks, apply_water_mask=False)
                    print(f"  gönderildi {name}")
                except Exception as err:  # noqa: BLE001
                    print(f"  HATA {name}: {err}")
                    continue
            jobs_by_name[name] = job
    if args.no_wait:
        print("İşler gönderildi; indirme için aynı komutu daha sonra çalıştırın.")
        return

    # Wait for the pending ones (HyP3 batches finish in ~10–40 min), then download the coherence rasters.
    from hyp3_sdk import Batch

    pending = Batch([j for j in jobs_by_name.values() if not j.complete()])  # type: ignore[attr-defined]
    if len(pending) > 0:
        print(f"{len(pending)} iş bekleniyor…")
        t0 = time.time()
        pending = hyp3.watch(pending, timeout=4 * 3600, interval=60)
        print(f"  tamamlandı ({(time.time() - t0) / 60:.0f} dk)")
        for j in pending:
            jobs_by_name[j.name] = j

    # Several bursts/orbits can share a pass (e.g. ascending 43 and 145): their pairs are merged into one
    # chronological series per pass, since the fusion model keeps one coherence channel per pass.
    out_passes: list[dict] = []
    series_out: dict[str, dict[str, list[float | None]]] = {gid: {} for gid in geoms}
    merged: dict[str, dict] = {}
    for p in plan:
        coh_dir = Path(args.s1) / lib.name / "hyp3" / str(p["orbit"])
        coh_dir.mkdir(parents=True, exist_ok=True)
        done_pairs: list[list[str]] = []
        for a, b in p["pairs"]:
            name = f"{JOB_PREFIX}-{lib.name}-{p['orbit']}-{a['date']}_{b['date']}-{args.looks}"
            job = jobs_by_name.get(name)
            tif = coh_dir / f"{a['date']}_{b['date']}_corr.tif"
            if not tif.exists():
                if job is None or not job.succeeded():  # type: ignore[attr-defined]
                    status = getattr(job, "status_code", "yok")
                    print(f"  {name}: {status}, atlandı")
                    continue
                try:
                    paths = job.download_files(coh_dir)  # type: ignore[attr-defined]
                except Exception as err:  # noqa: BLE001
                    print(f"  {name}: indirme hatası {err}")
                    continue
                for z in paths:
                    z = Path(z)
                    if z.suffix == ".zip":
                        with zipfile.ZipFile(z) as zf:
                            corr = [n for n in zf.namelist() if n.endswith("_corr.tif")]
                            if corr:
                                zf.extract(corr[0], coh_dir)
                                Path(coh_dir / corr[0]).replace(tif)
                        z.unlink(missing_ok=True)
                if not tif.exists():
                    print(f"  {name}: _corr.tif bulunamadı")
                    continue
            done_pairs.append([a["date"], b["date"]])
        if not done_pairs:
            print(f"yörünge {p['orbit']}: hazır çift yok, atlandı")
            continue
        bucket = merged.setdefault(p["pass"], {"orbits": [], "bursts": [], "rows": []})
        bucket["orbits"].append(p["orbit"])
        bucket["bursts"].append(p["burstId"])
        for d1, d2 in done_pairs:
            means = zonal_mean(coh_dir / f"{d1}_{d2}_corr.tif", geoms)
            bucket["rows"].append((d1, d2, p["orbit"], means))
        print(f"yörünge {p['orbit']}: {len(done_pairs)} çift hazır")
    for pass_name, bucket in merged.items():
        rows = sorted(bucket["rows"], key=lambda r: (r[1], r[0]))
        out_passes.append({
            "pass": pass_name,
            "relativeOrbit": bucket["orbits"][0],
            "relativeOrbits": bucket["orbits"],
            "burstId": bucket["bursts"][0],
            "burstIds": bucket["bursts"],
            "pairs": [[r[0], r[1]] for r in rows],
            "pairOrbits": [r[2] for r in rows],
        })
        for gid in geoms:
            series_out[gid][pass_name] = [r[3][gid] for r in rows]
        print(f"{pass_name}: {len(rows)} çift ({', '.join(str(o) for o in bucket['orbits'])} yörüngeleri birleştirildi)")

    out_path = lib / "pruning-radar" / f"coherence-hyp3-{season}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"season": season, "source": "hyp3", "looks": args.looks, "passes": out_passes, "gardens": series_out}), encoding="utf-8")
    print(f"Çıktı: {out_path}")


if __name__ == "__main__":
    sys.exit(main())
