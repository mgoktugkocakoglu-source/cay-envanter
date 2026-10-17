"""Delete truncated burst TIFF / annotation XML files in a burst2stack folder so they get re-fetched.

    .venv/Scripts/python py/s1_validate.py <folder> <bursts.json>

A burst TIFF is complete when it is at least as large as ASF's `bytes` for the burst (the
delivered GeoTIFF carries ~22 KB of extra header); annotation XMLs must parse.
"""
import json
import sys
from pathlib import Path

from lxml import etree

root = Path(sys.argv[1])
expected = {b["fileName"]: int(b.get("bytes") or 0) for b in json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))}
bad = []
for p in root.glob("*.xml"):
    try:
        etree.parse(str(p))
    except Exception:
        bad.append(p)
for p in root.glob("*BURST.tiff"):
    need = expected.get(p.name, 0)
    if need and p.stat().st_size < need:
        bad.append(p)
for p in bad:
    p.unlink()
print(f"silinen bozuk dosya: {len(bad)}", [b.name for b in bad][:6])
