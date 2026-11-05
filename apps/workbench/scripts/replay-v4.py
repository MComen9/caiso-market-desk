#!/usr/bin/env python3
"""Replay the two frozen V4 simulations without training or network access."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public/data/forecast-lab/v4"
OUTPUT = ROOT / ".local-runtime/v4-replay"


def main() -> None:
    if not (DATA / "report.json").is_file():
        raise SystemExit("Run npm run data:sync from apps/workbench first.")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    cases = [
        ("forward", "embedded-data.json", "forward-plan.json", ["--date", "2026-10-31"]),
        ("development", "holdout-input.json", "holdout-simulation.json", []),
    ]
    checked = []
    for label, source, expected, extra in cases:
        destination = OUTPUT / f"{label}.json"
        subprocess.run([
            sys.executable, str(ROOT / "research/trading_strategy.py"),
            "--data", str(DATA / source), "--strategy", "normal", "--k", "0.5",
            "--fee-per-mwh", "1", "--output", str(destination), *extra,
        ], check=True, cwd=ROOT)
        actual = json.loads(destination.read_text())
        frozen = json.loads((DATA / expected).read_text())
        # Execution timestamps change by design. Model generation, input, config
        # and every numerical decision/result must remain exactly unchanged.
        for key in ("day", "backtest", "config", "inputDigest", "forecastGeneratedAt"):
            if actual[key] != frozen[key]:
                raise AssertionError(f"{label}: replay differs in {key}")
        checked.append({"case": label, "identical": True})
    forecast = json.loads((DATA / "forecast-forward.json").read_text())
    points = forecast["points"]
    assert len(points) == 72
    assert all(point[key] is None for point in points for key in ("actualDa", "actualFmm", "actualSpread"))
    print(json.dumps({"replays": checked, "forecastRows": len(points), "actualsRemainUnknown": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
