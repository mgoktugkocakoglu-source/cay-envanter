"""Sentinel-1 burst SLC discovery and download for one neighbourhood (ASF, Earthdata login).

Burst-level SLC products (~100–200 MB each) replace the 4–8 GB full frames: a neighbourhood
needs one burst per orbit pass per date, so a whole pruning season fits in ~10 GB.

    .venv/Scripts/python py/s1_bursts.py --dir data/library/trabzon/of/cataldere --season 2025 [--download]
"""
from __future__ import annotations

import argparse
import json
import re
import time
from datetime import date, timedelta
from pathlib import Path

import asf_search as asf
from shapely.geometry import shape


def read_credentials(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    user = re.search(r"Kullanıcı:\s*(\S+)", text)
    pw = re.search(r"Şifre:\s*(\S+)", text)
    if not user or not pw:
        raise SystemExit(f"{path}: 'Kullanıcı:' ve 'Şifre:' satırları bekleniyor")
    return user.group(1), pw.group(1)


def boundary_wkt(meta: dict) -> str:
    """Bounding box of the neighbourhood as WKT (ASF intersects with it)."""
    coords = json.dumps(meta["boundary"]["coordinates"])
    xs = [float(x) for x in re.findall(r"\[(-?\d+\.?\d*),\s*-?\d+\.?\d*\]", coords)]
    ys = [float(y) for y in re.findall(r"\[-?\d+\.?\d*,\s*(-?\d+\.?\d*)\]", coords)]
    w, s, e, n = min(xs), min(ys), max(xs), max(ys)
    return f"POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="neighbourhood library folder (has meta.json)")
    ap.add_argument("--season", type=int, default=2025, help="pruning season start year")
    ap.add_argument("--download", action="store_true", help="download the bursts (needs secrets/earthdata.txt)")
    ap.add_argument("--orbits", default="", help="comma-separated relative orbits to download (default: all)")
    ap.add_argument("--min-cover", type=float, default=0.2, help="skip bursts covering less than this share of the neighbourhood")
    ap.add_argument("--limit", type=int, default=0, help="download at most N files (test)")
    ap.add_argument("--out", default="data/s1", help="download root")
    ap.add_argument("--dest", default="", help="explicit download directory (e.g. the burst2stack output dir, so it skips its own flaky download)")
    args = ap.parse_args()

    lib = Path(args.dir)
    meta = json.loads((lib / "meta.json").read_text(encoding="utf-8"))
    wkt = boundary_wkt(meta)
    start, end = f"{args.season}-09-01", f"{args.season + 1}-05-15"
    print(f"ASF arama: Sentinel-1 burst SLC, {start} → {end}, {wkt}")

    # Month by month: the ASF API resets the connection on season-long burst queries.
    results = []
    seen: set[str] = set()
    cursor = date.fromisoformat(start)
    stop = date.fromisoformat(end)
    while cursor < stop:
        nxt = min(stop, (cursor.replace(day=1) + timedelta(days=32)).replace(day=1))
        for attempt in range(4):
            try:
                chunk = asf.search(
                    platform=[asf.PLATFORM.SENTINEL1],
                    processingLevel=[asf.PRODUCT_TYPE.BURST],
                    polarization=["VV"],  # VV coheres best; VH bursts are not needed for coherence
                    intersectsWith=wkt,
                    start=cursor.isoformat(),
                    end=nxt.isoformat(),
                )
                break
            except Exception as err:  # noqa: BLE001 — network resets, retry
                if attempt == 3:
                    raise
                print(f"  {cursor} yeniden deneniyor ({err.__class__.__name__})")
                time.sleep(3)
        for r in chunk:
            if r.properties["fileID"] not in seen:
                seen.add(r.properties["fileID"])
                results.append(r)
        print(f"  {cursor:%Y-%m}: {len(chunk)} burst")
        cursor = nxt
    # Share of the neighbourhood each burst footprint covers (the boundary may straddle two bursts).
    boundary = shape(meta["boundary"])
    bursts = []
    for r in results:
        p = r.properties
        b = p.get("burst", {})
        footprint = shape(r.geometry) if r.geometry else None
        cover = round(footprint.intersection(boundary).area / boundary.area, 3) if footprint else None
        bursts.append(
            {
                "fileID": p["fileID"],
                "fileName": p["fileName"],
                "cover": cover,
                "date": p["startTime"][:10],
                "pass": p["flightDirection"],
                "relativeOrbit": p["pathNumber"],
                "polarization": p["polarization"],
                "burstId": b.get("fullBurstID"),
                "subswath": b.get("subswath"),
                "sizeMB": round(float(p.get("bytes") or 0) / 1e6),
                "bytes": int(float(p.get("bytes") or 0)),
                "url": p["url"],
                # Burst metadata (annotation XML) SNAP needs next to the TIFF.
                "xmlUrl": next((u for u in p.get("additionalUrls") or [] if u.endswith(".xml")), None),
            }
        )
    bursts.sort(key=lambda x: (x["pass"], x["date"]))
    by_id: dict[str, list] = {}
    for b in bursts:
        by_id.setdefault(f"{b['pass']} {b['relativeOrbit']} {b['burstId']} {b['polarization']}", []).append(b)
    print(f"{len(bursts)} burst ürünü, {len(by_id)} burst kimliği:")
    for key, items in sorted(by_id.items()):
        cover = items[0]["cover"]
        print(f"  {key}: {len(items)} tarih ({items[0]['date']} → {items[-1]['date']}), ~{sum(i['sizeMB'] for i in items) / 1000:.1f} GB, mahallenin %{round((cover or 0) * 100)}'ini kapsıyor")

    out_dir = Path(args.out) / lib.name / f"season-{args.season}-{str(args.season + 1)[2:]}"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "bursts.json").write_text(json.dumps(bursts, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Liste: {out_dir / 'bursts.json'}")

    if not args.download:
        return
    if args.dest:
        out_dir = Path(args.dest)
        out_dir.mkdir(parents=True, exist_ok=True)
    user, pw = read_credentials(Path("secrets/earthdata.txt"))
    session = asf.ASFSession().auth_with_creds(user, pw)
    orbits = {int(o) for o in args.orbits.split(",") if o.strip()}
    wanted = [b for b in bursts if (not orbits or b["relativeOrbit"] in orbits) and (b["cover"] or 0) >= args.min_cover]
    # ASF's `bytes` is the raw burst size; the delivered GeoTIFF is ~22 KB larger. A shorter file
    # is an interrupted download (a stub), a larger one is complete.
    def complete(b: dict) -> bool:
        f = out_dir / b["fileName"]
        return f.exists() and (not b["bytes"] or f.stat().st_size >= b["bytes"])

    for b in wanted:
        f = out_dir / b["fileName"]
        if f.exists() and not complete(b):
            f.unlink()
    todo = [b for b in wanted if not complete(b)]
    if args.limit:
        todo = todo[: args.limit]
    print(f"İndiriliyor: {len(todo)} dosya (~{sum(b['sizeMB'] for b in todo) / 1000:.1f} GB) → {out_dir}")
    # ASF burst URLs all end in "<n>.tiff": name each file by its burst id, and fetch the XML too.
    for i, b in enumerate(todo, 1):
        for attempt in range(3):
            try:
                asf.download_url(b["url"], path=str(out_dir), filename=b["fileName"], session=session)
                if b["xmlUrl"]:
                    asf.download_url(b["xmlUrl"], path=str(out_dir), filename=b["fileName"].replace(".tiff", ".xml"), session=session)
                break
            except Exception as err:  # noqa: BLE001
                if attempt == 2:
                    raise
                print(f"  {b['fileName']}: yeniden ({err.__class__.__name__})")
                time.sleep(5)
        print(f"  {i}/{len(todo)} {b['fileName']}", flush=True)
    print("Bitti.")


if __name__ == "__main__":
    main()
