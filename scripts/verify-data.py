#!/usr/bin/env python3
"""Verify the complete published snapshot without fetching or changing data."""
from pathlib import Path
from collections import Counter
import csv
import hashlib
import json
import math

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "published"


def main():
    manifest = json.loads((ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))
    seen = set()
    total = 0
    for item in manifest["files"]:
        rel = Path(item["path"])
        assert not rel.is_absolute() and ".." not in rel.parts, "Unsafe manifest path"
        assert item["path"] not in seen, f"Duplicate manifest entry: {rel}"
        seen.add(item["path"])
        path = DATA / rel
        assert path.is_file() and not path.is_symlink(), f"Missing regular data file: {rel}"
        raw = path.read_bytes()
        assert len(raw) == item["bytes"], f"Size mismatch: {rel}"
        assert hashlib.sha256(raw).hexdigest() == item["sha256"], f"SHA-256 mismatch: {rel}"
        total += len(raw)
    actual = {p.relative_to(DATA).as_posix() for p in DATA.rglob("*") if p.is_file()}
    assert actual == seen, f"Unlisted or missing data files: {sorted(actual ^ seen)}"
    assert len(seen) == manifest["fileCount"]
    assert total == manifest["totalBytes"]

    v4 = DATA / "forecast-lab" / "v4"
    forecast = json.loads((v4 / "forecast-forward.json").read_text(encoding="utf-8"))
    report = json.loads((v4 / "report.json").read_text(encoding="utf-8"))
    points = forecast["points"]
    assert len(points) == 72
    assert len({(p["node"], p["startUtc"]) for p in points}) == 72
    assert sorted(Counter(p["node"] for p in points).values()) == [24, 24, 24]
    assert {p["localDate"] for p in points} == {manifest["forecastTargetDatePT"]}
    assert forecast["modelVersion"] == manifest["forecastModel"]
    assert forecast["generatedAt"] == manifest["forecastGeneratedAt"]
    for point in points:
        assert all(point[k] is None for k in ("actualDa", "actualFmm", "actualSpread"))
        assert math.isclose(point["predictedFmm"], point["predictedDa"] + point["predictedSpread"], abs_tol=1e-10)
    with (v4 / "forward-predictions.csv").open(newline="", encoding="utf-8-sig") as handle:
        assert len(list(csv.DictReader(handle))) == 72
    assert report["sample"]["rows"] == 26352
    assert report["holdout"]["classification"] == "previously_seen_development_comparison"
    print(json.dumps({"ok": True, "files": len(seen), "bytes": total, "forwardRows": 72,
                      "modelVersion": forecast["modelVersion"], "targetDatePT": manifest["forecastTargetDatePT"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
